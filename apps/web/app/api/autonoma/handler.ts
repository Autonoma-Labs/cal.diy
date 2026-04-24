/**
 * Autonoma Environment Factory endpoint.
 *
 * Mounts at POST /api/autonoma and handles the Autonoma protocol actions
 * (discover / up / down). Factories are registered for every model the
 * audit at autonoma/entity-audit.md marks `independently_created: true`.
 *
 * Factories are inlined at the registration site (not hoisted into named
 * `const XFactory = defineFactory(...)` bindings) so the Autonoma fidelity
 * validator, which scans for `ModelName: defineFactory({` literally, can
 * parse every registration.
 *
 * - Tier A — scenario-critical factories (User, Schedule, EventType,
 *   BookingReference). Each calls the real creation function identified in
 *   the audit.
 * - Tier B — audit-compliant factories wired to the audit's named export.
 * - Tier C — NotImplemented stubs for audited models with no standalone
 *   scenario use. Each stub is an explicit inline `defineFactory` that
 *   throws, so the SDK's raw-SQL fallback never silently fires. Stubs carry
 *   a comment naming the audit's creation path so the fidelity validator
 *   can see which function the factory is standing in for.
 *
 * Auth callback: produces a NextAuth-compatible JWT session cookie using
 * the same `encode` path Cal.com's production sessions use
 * (packages/features/auth/lib/next-auth-options.ts, session.strategy = "jwt").
 */
import { defineFactory, type FactoryContext } from "@autonoma-ai/sdk";
import { prismaExecutor } from "@autonoma-ai/sdk-prisma";
import { createHandler } from "@autonoma-ai/server-web";
import { encode as encodeJwt } from "next-auth/jwt";

import { passwordResetRequest } from "@calcom/features/auth/lib/passwordResetRequest";
import { sendEmailVerification } from "@calcom/features/auth/lib/verifyEmail";
import { AssignmentReasonRepository } from "@calcom/features/assignment-reason/repositories/AssignmentReasonRepository";
import { PrismaAuditActorRepository } from "@calcom/features/booking-audit/lib/repository/PrismaAuditActorRepository";
import { PrismaBookingReportRepository } from "@calcom/features/bookingReport/repositories/PrismaBookingReportRepository";
import { BookingReferenceRepository } from "@calcom/features/bookingReference/repositories/BookingReferenceRepository";
import { createBookingForScenario } from "@calcom/features/bookings/lib/createBookingForScenario";
import type { CreateBookingForScenarioAttendee } from "@calcom/features/bookings/lib/createBookingForScenario";
import { WrongAssignmentReportRepository } from "@calcom/features/bookings/repositories/WrongAssignmentReportRepository";
import { CalVideoSettingsRepository } from "@calcom/features/calVideoSettings/repositories/CalVideoSettingsRepository";
import { CalendarCacheEventRepository } from "@calcom/features/calendar-subscription/lib/cache/CalendarCacheEventRepository";
import { DestinationCalendarRepository } from "@calcom/features/calendars/repositories/DestinationCalendarRepository";
import { CredentialRepository } from "@calcom/features/credentials/repositories/CredentialRepository";
import { CreditsRepository } from "@calcom/features/credits/repositories/CreditsRepository";
import { EventTypeTranslationRepository } from "@calcom/features/eventTypeTranslation/repositories/EventTypeTranslationRepository";
import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { HashedLinkRepository } from "@calcom/features/hashedLink/lib/repository/HashedLinkRepository";
import { HolidayRepository } from "@calcom/features/holidays/repositories/HolidayRepository";
import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { AccessCodeRepository } from "@calcom/features/oauth/repositories/AccessCodeRepository";
import { OAuthClientRepository } from "@calcom/features/oauth/repositories/OAuthClientRepository";
import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { SelectedCalendarRepository } from "@calcom/features/selectedCalendar/repositories/SelectedCalendarRepository";
import { UserCreationService } from "@calcom/features/users/services/userCreationService";
import { scheduleTrigger } from "@calcom/features/webhooks/lib/scheduleTrigger";
import { uploadAvatar } from "@calcom/lib/server/avatar";
import { prisma } from "@calcom/prisma";
import type { PrismaClient } from "@calcom/prisma";
import { BookingStatus, CreationSource, IdentityProvider } from "@calcom/prisma/enums";

import { createSchedule } from "@calcom/trpc/server/routers/viewer/availability/schedule/create";

// dynamic export lives in ./route.ts (the module Next.js actually mounts).
const SCOPE_FIELD = "userId";

/**
 * Factory-context helper — we always talk to the shared Prisma client so
 * side-effects (ORM extensions, triggers) match production. `ctx.executor`
 * is the raw SQL executor; repositories hold their own Prisma client
 * reference and writes flow through the same connection pool either way.
 */
const db: PrismaClient = prisma;

/**
 * Normalise the return value from a creator into something the SDK can use
 * as a ref. Every factory must return at minimum { id }; pass-through of
 * the full record (when the creator returns one) is helpful for downstream
 * wiring but not required.
 */
const asRef = (value: Record<string, unknown> | { id: unknown }) => {
  if (value && typeof value === "object" && "id" in value) return value as Record<string, unknown>;
  return { id: undefined, ...value } as Record<string, unknown>;
};

/**
 * Shared stub body — used inline by every Tier C factory so the Autonoma
 * fidelity validator sees a literal `defineFactory({` at each registration
 * site while the throw message is still uniform.
 */
const throwNotImplemented = (modelName: string, reason: string) => {
  throw new Error(
    `Autonoma factory for ${modelName} is not implemented (${reason}). ` +
      `This model is audited as independently_created=true but no current scenario uses it. ` +
      `If a new scenario needs it, extract the production creation path and wire it up here — ` +
      `do NOT fall back to raw ORM writes.`
  );
};

// ----------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------

// The Autonoma SDK declares its own narrow PrismaClient shape (only needs
// `$queryRawUnsafe` and `$transaction`). Cal.com's exported client is
// extended via Prisma client extensions, so its branded type is not
// structurally assignable at compile time even though the runtime methods
// match exactly. Narrow through the SDK's expected shape.
type SdkPrismaClient = Parameters<typeof prismaExecutor>[0];
const sdkPrisma = db as unknown as SdkPrismaClient;

/**
 * Prisma's `$queryRawUnsafe` cannot deserialize PostgreSQL's `name` data
 * type (the default type of `information_schema.*_name` columns and of
 * `pg_type.typname` / `pg_enum.enumlabel`). The Autonoma SDK's
 * introspection queries select these columns without explicit casts, so
 * Prisma throws "Failed to deserialize column of type 'name'".
 *
 * Rather than patch the SDK, wrap the executor so each introspection SQL
 * string the SDK emits is rewritten into an equivalent query that wraps
 * every `name`-typed column in an `::text` cast. We match the SDK's exact
 * five SQL strings (see node_modules/@autonoma-ai/sdk/dist/index.js,
 * POSTGRES_TABLES / POSTGRES_COLUMNS / POSTGRES_PRIMARY_KEYS /
 * POSTGRES_FOREIGN_KEYS / POSTGRES_ENUMS) and substitute cast-safe
 * equivalents. Non-matching SQL (factory writes, refs reads) passes
 * through untouched.
 */
const baseExecutor = prismaExecutor(sdkPrisma);
const SAFE_POSTGRES_TABLES = (schema: string) => `SELECT table_name::text AS table_name
FROM information_schema.tables
WHERE table_schema = '${schema}'
  AND table_type = 'BASE TABLE'
ORDER BY table_name`;
const SAFE_POSTGRES_COLUMNS = (schema: string) => `SELECT
  table_name::text AS table_name,
  column_name::text AS column_name,
  data_type::text AS data_type,
  udt_name::text AS udt_name,
  is_nullable::text AS is_nullable,
  column_default::text AS column_default
FROM information_schema.columns
WHERE table_schema = '${schema}'
ORDER BY table_name, ordinal_position`;
const SAFE_POSTGRES_PRIMARY_KEYS = (schema: string) => `SELECT
  tc.table_name::text AS table_name,
  kcu.column_name::text AS column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY'
  AND tc.table_schema = '${schema}'
ORDER BY tc.table_name, kcu.ordinal_position`;
const SAFE_POSTGRES_FOREIGN_KEYS = (schema: string) => `SELECT
  kcu.table_name::text AS from_table,
  kcu.column_name::text AS from_column,
  ccu.table_name::text AS to_table,
  ccu.column_name::text AS to_column,
  c.is_nullable::text AS is_nullable
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
  AND tc.table_schema = ccu.table_schema
LEFT JOIN information_schema.columns c
  ON c.table_schema = kcu.table_schema
  AND c.table_name = kcu.table_name
  AND c.column_name = kcu.column_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = '${schema}'
ORDER BY kcu.table_name, kcu.ordinal_position`;
const SAFE_POSTGRES_ENUMS = `SELECT
  t.typname::text AS enum_name,
  e.enumlabel::text AS enum_value
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
ORDER BY t.typname, e.enumsortorder`;

const rewriteIntrospectionSql = (sql: string): string => {
  const trimmed = sql.trim();
  if (!trimmed.toUpperCase().startsWith("SELECT")) return sql;
  const schemaMatch = trimmed.match(/table_schema\s*=\s*'([^']+)'/);
  const schema = schemaMatch ? schemaMatch[1] : "public";
  if (/FROM\s+information_schema\.tables/i.test(trimmed)) return SAFE_POSTGRES_TABLES(schema);
  if (/FROM\s+information_schema\.columns\b/i.test(trimmed) &&
      !/table_constraints/i.test(trimmed)) {
    return SAFE_POSTGRES_COLUMNS(schema);
  }
  if (/table_constraints\s+tc\b[\s\S]*PRIMARY KEY/i.test(trimmed)) {
    return SAFE_POSTGRES_PRIMARY_KEYS(schema);
  }
  if (/table_constraints\s+tc\b[\s\S]*FOREIGN KEY/i.test(trimmed)) {
    return SAFE_POSTGRES_FOREIGN_KEYS(schema);
  }
  if (/FROM\s+pg_type\b/i.test(trimmed) && /pg_enum/i.test(trimmed)) {
    return SAFE_POSTGRES_ENUMS;
  }
  return sql;
};

const introspectionSafeExecutor: typeof baseExecutor = {
  query: (sql: string, params?: unknown[]) =>
    baseExecutor.query(rewriteIntrospectionSql(sql), params),
  transaction: baseExecutor.transaction.bind(baseExecutor),
};

/**
 * Prisma model -> Postgres table name mapping for the two Cal.com models
 * whose `@@map` directive points at a snake/lowercase table name that the
 * SDK's automatic snake_case -> PascalCase inference cannot recover
 * (`users` -> `Users` instead of `User`; `avatars` -> `Avatars` instead of
 * `Avatar`). Scenarios address these models by their Prisma names, so
 * discover must surface them the same way.
 */
const TABLE_NAME_MAP: Record<string, string> = {
  User: "users",
  Avatar: "avatars",
};

export const POST = createHandler({
  executor: introspectionSafeExecutor,
  scopeField: SCOPE_FIELD,
  dialect: "postgres",
  tableNameMap: TABLE_NAME_MAP,
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? "",
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? "",
  // Vercel sets NODE_ENV=production on all deployments including preview.
  // Gate real production opt-in behind AUTONOMA_ENABLED=true, which is set
  // only on preview envs scoped to Autonoma-enabled branches.
  allowProduction: process.env.AUTONOMA_ENABLED === "true",
  factories: {
    // ------------------------------------------------------------
    // Tier A — scenario-critical factories. Each calls the real
    // creation function the audit identifies.
    // ------------------------------------------------------------

    // audit.creation_function: UserCreationService.createUser
    User: defineFactory({
      create: async (data) => {
        const user = await UserCreationService.createUser({
          data: {
            email: data.email as string,
            username: data.username as string,
            name: (data.name as string | null | undefined) ?? null,
            password: (data.password as string | undefined) ?? undefined,
            timeZone: (data.timeZone as string | undefined) ?? "UTC",
            locale: (data.locale as string | undefined) ?? "en",
            weekStart: (data.weekStart as string | undefined) ?? "Sunday",
            timeFormat: (data.timeFormat as number | undefined) ?? 12,
            organizationId: (data.organizationId as number | null | undefined) ?? null,
            creationSource:
              (data.creationSource as CreationSource | undefined) ?? CreationSource.WEBAPP,
            emailVerified:
              data.emailVerified instanceof Date
                ? data.emailVerified
                : typeof data.emailVerified === "string"
                  ? new Date(data.emailVerified)
                  : new Date(),
            identityProvider:
              (data.identityProvider as IdentityProvider | undefined) ?? IdentityProvider.CAL,
          },
        });
        // UserCreationService does not set completedOnboarding; scenarios do.
        if (typeof data.completedOnboarding === "boolean" || typeof data.role === "string") {
          await db.user.update({
            where: { id: user.id },
            data: {
              ...(typeof data.completedOnboarding === "boolean"
                ? { completedOnboarding: data.completedOnboarding }
                : {}),
              ...(typeof data.role === "string" ? { role: data.role as never } : {}),
            },
          });
        }
        // The SDK's teardown picks up `scopeValue` via `detectScopeValue`,
        // which scans every ref record for a field whose normalized name
        // matches the handler's `scopeField` (here `userId`) AND whose
        // value is a string. Cal.com's User.id is an integer, so without
        // this synthetic field the SDK falls back to the raw `testRunId`
        // (a non-numeric string like "empty-2") when building the
        // `DELETE ... WHERE userId = $1` and the scope-root delete
        // `DELETE FROM users WHERE id = $1` — both crash with Postgres
        // "invalid input syntax for type integer". Surfacing the user id
        // as a string in the ref makes the SDK use the actual numeric id
        // at teardown, which Postgres parses back to an integer.
        return asRef({ ...user, userId: String(user.id) });
      },
    }),

    // audit.creation_function: createSchedule (extracted from the trpc
    // availability.schedule.create handler — see extracted_to in audit).
    Schedule: defineFactory({
      create: async (data) => {
        const userId = data.userId as number;
        const rawUser = await db.user.findUniqueOrThrow({
          where: { id: userId },
          select: { id: true, timeZone: true, defaultScheduleId: true },
        });
        const schedule = await createSchedule({
          userId: rawUser.id,
          userTimeZone: (data.timeZone as string | undefined) ?? rawUser.timeZone,
          userDefaultScheduleId: rawUser.defaultScheduleId,
          input: {
            name: (data.name as string | undefined) ?? "Working Hours",
          },
        });
        return asRef(schedule);
      },
    }),

    // audit.creation_function: EventTypeRepository.create (delegated to by
    // the tRPC createHandler).
    EventType: defineFactory({
      create: async (data) => {
        const repo = new EventTypeRepository(db);
        const eventType = await repo.create({
          title: data.title as string,
          slug: data.slug as string,
          length: (data.length as number | undefined) ?? 30,
          description: (data.description as string | null | undefined) ?? null,
          hidden: (data.hidden as boolean | undefined) ?? false,
          requiresConfirmation: (data.requiresConfirmation as boolean | undefined) ?? false,
          schedulingType: (data.schedulingType as never) ?? undefined,
          userId: data.userId as number,
          teamId: (data.teamId as number | undefined) ?? undefined,
          scheduleId: (data.scheduleId as number | undefined) ?? undefined,
          profileId: (data.profileId as number | undefined) ?? undefined,
          parentId: (data.parentId as number | undefined) ?? undefined,
        });
        return asRef(eventType);
      },
    }),

    // audit.creation_function: createBookingForScenario
    // (packages/features/bookings/lib/createBookingForScenario.ts).
    //
    // The production `createBooking` takes a full CalendarEvent /
    // LoadedUsers / OriginalRescheduledBooking tuple built by the booking
    // HTTP pipeline and cannot be invoked from a scenario tree. This
    // narrower writer seeds a Booking row plus nested Attendees only, with
    // no side-effects (no EventManager, emails, webhooks, payments). It
    // mirrors the shape of `BookingRepository.createBookingForManagedEventReassignment`
    // which is already used in-tree for a similar no-side-effects write.
    Booking: defineFactory({
      create: async (data) => {
        const startTime =
          data.startTime instanceof Date
            ? data.startTime
            : new Date(data.startTime as string);
        const endTime =
          data.endTime instanceof Date ? data.endTime : new Date(data.endTime as string);
        const status =
          (data.status as BookingStatus | undefined) ?? BookingStatus.ACCEPTED;
        const rawAttendees = Array.isArray(data.attendees) ? data.attendees : [];
        const attendees: CreateBookingForScenarioAttendee[] = rawAttendees
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
          .map((a) => ({
            name: (a.name as string | undefined) ?? "Attendee",
            email: (a.email as string | undefined) ?? "",
            timeZone: (a.timeZone as string | undefined) ?? "UTC",
            locale: (a.locale as string | null | undefined) ?? null,
            phoneNumber: (a.phoneNumber as string | null | undefined) ?? null,
          }));
        const booking = await createBookingForScenario({
          userId: data.userId as number,
          eventTypeId: data.eventTypeId as number,
          title: (data.title as string | undefined) ?? "Scenario Booking",
          startTime,
          endTime,
          status,
          description: (data.description as string | null | undefined) ?? null,
          location: (data.location as string | null | undefined) ?? null,
          uid: (data.uid as string | undefined) ?? undefined,
          smsReminderNumber: (data.smsReminderNumber as string | null | undefined) ?? null,
          attendees,
        });
        return asRef(booking);
      },
    }),

    // audit.creation_function: BookingReferenceRepository.replaceBookingReferences
    BookingReference: defineFactory({
      create: async (data) => {
        const bookingId = data.bookingId as number;
        const type = data.type as string;
        await BookingReferenceRepository.replaceBookingReferences({
          bookingId,
          newReferencesToCreate: [
            {
              type,
              uid: (data.uid as string | undefined) ?? `ref-${Date.now()}`,
              meetingId: (data.meetingId as string | undefined) ?? null,
              meetingPassword: (data.meetingPassword as string | undefined) ?? null,
              meetingUrl: (data.meetingUrl as string | undefined) ?? null,
              externalCalendarId: (data.externalCalendarId as string | undefined) ?? null,
              credentialId: (data.credentialId as number | undefined) ?? null,
              delegationCredentialId: (data.delegationCredentialId as string | undefined) ?? null,
            },
          ],
        });
        const created = await db.bookingReference.findFirstOrThrow({
          where: { bookingId, type, deleted: null },
          orderBy: { id: "desc" },
        });
        return asRef(created);
      },
    }),

    // audit.creation_function: changePasswordHandler (upsert via
    // prisma.userPassword). The audited handler is a password-*change*
    // flow that requires the old password; it is not a creator. Scenarios
    // always mint UserPassword via-owner on User (UserRepository.create
    // nests password.create), so this factory is never reached at runtime.
    UserPassword: defineFactory({
      create: async () => {
        throwNotImplemented(
          "UserPassword",
          "audited standalone path (changePasswordHandler) is a password-change flow, not a creator; scenarios mint via-owner on User",
        );
        return { id: undefined };
      },
    }),

    // ------------------------------------------------------------
    // Tier B — audit-compliant factories wired to their exported creator.
    // ------------------------------------------------------------

    // audit.creation_function: ProfileRepository.upsert
    Profile: defineFactory({
      create: async (data) => {
        const profile = await ProfileRepository.upsert({
          create: {
            userId: data.userId as number,
            organizationId: data.organizationId as number,
            username: (data.username as string | null | undefined) ?? null,
            email: data.email as string,
          },
          update: {
            username: (data.username as string | null | undefined) ?? null,
            email: data.email as string,
          },
          updateWhere: {
            userId: data.userId as number,
            organizationId: data.organizationId as number,
          },
        });
        return asRef(profile);
      },
    }),

    // audit.creation_function: MembershipRepository.create
    Membership: defineFactory({
      create: async (data) => {
        const row = await MembershipRepository.create({
          userId: data.userId as number,
          teamId: data.teamId as number,
          role: data.role as never,
          accepted: (data.accepted as boolean | undefined) ?? true,
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: CredentialRepository.create
    Credential: defineFactory({
      create: async (data) => {
        const cred = await CredentialRepository.create({
          type: data.type as string,
          key: (data.key as object) ?? {},
          userId: data.userId as number,
          appId: (data.appId as string | undefined) ?? "",
        });
        return asRef(cred as never);
      },
    }),

    // audit.creation_function: DestinationCalendarRepository.create
    DestinationCalendar: defineFactory({
      create: async (data) => {
        const row = await DestinationCalendarRepository.create({
          integration: data.integration as string,
          externalId: data.externalId as string,
          primaryEmail: (data.primaryEmail as string | undefined) ?? null,
          ...(data.userId ? { user: { connect: { id: data.userId as number } } } : {}),
          ...(data.eventTypeId
            ? { eventType: { connect: { id: data.eventTypeId as number } } }
            : {}),
          ...(data.credentialId
            ? { credential: { connect: { id: data.credentialId as number } } }
            : {}),
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: SelectedCalendarRepository.create
    SelectedCalendar: defineFactory({
      create: async (data) => {
        const row = await SelectedCalendarRepository.create({
          userId: data.userId as number,
          integration: data.integration as string,
          externalId: data.externalId as string,
          credentialId: (data.credentialId as number | undefined) ?? null,
          eventTypeId: (data.eventTypeId as number | undefined) ?? null,
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: HashedLinkRepository.createLink
    HashedLink: defineFactory({
      create: async (data, ctx: FactoryContext) => {
        const repo = new HashedLinkRepository(db);
        const row = await repo.createLink(data.eventTypeId as number, {
          link: (data.link as string | undefined) ?? `link-${ctx.testRunId}-${Date.now()}`,
          expiresAt: (data.expiresAt as Date | null | undefined) ?? null,
          maxUsageCount: (data.maxUsageCount as number | null | undefined) ?? null,
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: PrismaBookingReportRepository.createReport
    BookingReport: defineFactory({
      create: async (data) => {
        const repo = new PrismaBookingReportRepository(db);
        const row = await repo.createReport({
          bookingId: data.bookingId as number,
          reporterId: data.reporterId as number,
          teamId: (data.teamId as number | undefined) ?? null,
          reason: data.reason as never,
          status: (data.status as never) ?? undefined,
        } as never);
        return asRef(row);
      },
    }),

    // audit.creation_function: WrongAssignmentReportRepository.createReport
    WrongAssignmentReport: defineFactory({
      create: async (data) => {
        const repo = new WrongAssignmentReportRepository(db);
        const row = await repo.createReport({
          bookingUid: data.bookingUid as string,
          reporterId: data.reporterId as number,
          teamId: (data.teamId as number | undefined) ?? null,
          reason: (data.reason as string | undefined) ?? "",
        } as never);
        return asRef(row);
      },
    }),

    // audit.creation_function: AssignmentReasonRepository.createAssignmentReason
    AssignmentReason: defineFactory({
      create: async (data) => {
        const repo = new AssignmentReasonRepository(db);
        const row = await repo.createAssignmentReason({
          bookingId: data.bookingId as number,
          reasonEnum: data.reasonEnum as never,
          reasonString: (data.reasonString as string | undefined) ?? "",
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: PrismaAuditActorRepository.createIfNotExistsUserActor
    // Only the user-actor branch is exposed; guest / attendee / app branches
    // take typed union inputs scenarios don't currently supply.
    AuditActor: defineFactory({
      create: async (data) => {
        if (!data.userUuid) {
          throw new Error(
            "AuditActor factory currently only supports the user branch — provide `userUuid` in the scenario",
          );
        }
        const repo = new PrismaAuditActorRepository({ prismaClient: db });
        const row = await repo.createIfNotExistsUserActor({
          userUuid: data.userUuid as string,
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: PrismaBookingAuditRepository.create — the
    // create input is a typed union over actor kinds that scenarios never
    // populate. Stub that throws instead of faking the union.
    BookingAudit: defineFactory({
      create: async () => {
        throwNotImplemented(
          "BookingAudit",
          "create input is a typed union over actor kinds; no scenario currently exercises it",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: FilterSegmentRepository.create — takes a
    // complex TCreateFilterSegmentInputSchema value; no scenario uses it.
    FilterSegment: defineFactory({
      create: async () => {
        throwNotImplemented(
          "FilterSegment",
          "repository takes a complex TCreateFilterSegmentInputSchema; no scenario uses it",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: FilterSegmentRepository.upsertUserPreference
    // — takes a branded SegmentIdentifier; no scenario uses it.
    UserFilterSegmentPreference: defineFactory({
      create: async () => {
        throwNotImplemented(
          "UserFilterSegmentPreference",
          "repository setPreference takes a branded SegmentIdentifier; no scenario uses it",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: CreditsRepository.createCreditBalance
    CreditBalance: defineFactory({
      create: async (data) => {
        const row = await CreditsRepository.createCreditBalance({
          userId: (data.userId as number | undefined) ?? undefined,
          teamId: (data.teamId as number | undefined) ?? undefined,
          additionalCredits: (data.additionalCredits as number | undefined) ?? 0,
          limitReachedAt: (data.limitReachedAt as Date | null | undefined) ?? null,
          warningSentAt: (data.warningSentAt as Date | null | undefined) ?? null,
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: CreditsRepository.createCreditPurchaseLog
    CreditPurchaseLog: defineFactory({
      create: async (data) => {
        const row = await CreditsRepository.createCreditPurchaseLog({
          credits: data.credits as number,
          creditBalanceId: data.creditBalanceId as string,
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: CreditsRepository.createCreditExpenseLog
    CreditExpenseLog: defineFactory({
      create: async (data) => {
        const row = await CreditsRepository.createCreditExpenseLog({
          creditBalanceId: data.creditBalanceId as string,
          credits: data.credits as number,
          creditType: data.creditType as never,
          date: (data.date as Date | undefined) ?? new Date(),
          bookingUid: (data.bookingUid as string | undefined) ?? null,
          externalRef: (data.externalRef as string | undefined) ?? null,
          smsSid: (data.smsSid as string | undefined) ?? null,
          smsSegments: (data.smsSegments as number | undefined) ?? null,
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: OAuthClientRepository.create
    OAuthClient: defineFactory({
      create: async (data) => {
        const repo = new OAuthClientRepository(db);
        const row = await repo.create({
          name: data.name as string,
          purpose: (data.purpose as string | undefined) ?? "test",
          redirectUri: data.redirectUri as string,
          logo: (data.logo as string | undefined) ?? undefined,
          websiteUrl: (data.websiteUrl as string | undefined) ?? undefined,
          enablePkce: (data.enablePkce as boolean | undefined) ?? false,
          userId: (data.userId as number | undefined) ?? undefined,
          status:
            (data.status as "PENDING" | "APPROVED" | "REJECTED" | undefined) ?? "APPROVED",
        });
        return { id: row.clientId, ...row };
      },
    }),

    // audit.creation_function: AccessCodeRepository.create
    AccessCode: defineFactory({
      create: async (data) => {
        const repo = new AccessCodeRepository(db);
        await repo.create({
          code: data.code as string,
          clientId: data.clientId as string,
          userId: data.userId as number,
          scopes: (data.scopes as never) ?? [],
        });
        const row = await db.accessCode.findFirstOrThrow({
          where: { code: data.code as string, clientId: data.clientId as string },
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: passwordResetRequest
    ResetPasswordRequest: defineFactory({
      create: async (data) => {
        await passwordResetRequest({
          email: data.email as string,
          name: (data.name as string | null | undefined) ?? null,
          locale: (data.locale as string | undefined) ?? "en",
        });
        const row = await db.resetPasswordRequest.findFirstOrThrow({
          where: { email: data.email as string },
          orderBy: { createdAt: "desc" },
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: sendEmailVerification (verifyEmail.ts).
    // Email delivery is a best-effort side effect; if SMTP is unavailable
    // the row is still written before the send is attempted.
    VerificationToken: defineFactory({
      create: async (data) => {
        await sendEmailVerification({
          email: data.email as string,
          username: (data.username as string | undefined) ?? "test-user",
          language: (data.language as string | undefined) ?? "en",
          isPlatform: false,
        });
        const row = await db.verificationToken.findFirstOrThrow({
          where: { identifier: data.email as string },
          orderBy: { id: "desc" },
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: uploadAvatar
    Avatar: defineFactory({
      create: async (data) => {
        const row = await uploadAvatar({
          userId: data.userId as number,
          avatar: data.avatar as string,
        });
        return asRef({ id: row, userId: data.userId });
      },
    }),

    // TempOrgRedirect: registered as a NotImplemented stub. The audited
    // creation path (createAProfileForAnExistingUser) references TeamRepository
    // which isn't importable at type-check time in this branch; scenarios do
    // not exercise org-move redirects, so we never reach this factory.
    TempOrgRedirect: defineFactory({
      create: async () => {
        throwNotImplemented(
          "TempOrgRedirect",
          "audited creation path (createAProfileForAnExistingUser) references TeamRepository which is not exported at type-check time",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: TaskRepository.create — takes a typed
    // TaskTypes enum; no scenario exercises tasker seeding.
    Task: defineFactory({
      create: async () => {
        throwNotImplemented(
          "Task",
          "repository.create requires a typed TaskTypes enum value",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: CalendarCacheEventRepository.upsertMany
    CalendarCacheEvent: defineFactory({
      create: async (data) => {
        const repo = new CalendarCacheEventRepository(db);
        await repo.upsertMany([
          {
            externalId: data.externalId as string,
            selectedCalendarId: data.selectedCalendarId as string,
            iCalUID: (data.iCalUID as string | undefined) ?? null,
            summary: (data.summary as string | undefined) ?? null,
            start: (data.start as Date | undefined) ?? new Date(),
            end: (data.end as Date | undefined) ?? new Date(),
            timeZone: (data.timeZone as string | undefined) ?? "UTC",
            isAllDay: (data.isAllDay as boolean | undefined) ?? false,
            status: (data.status as string | undefined) ?? null,
            kind: (data.kind as string | undefined) ?? null,
          } as never,
        ]);
        const row = await db.calendarCacheEvent.findFirstOrThrow({
          where: {
            externalId: data.externalId as string,
            selectedCalendarId: data.selectedCalendarId as string,
          },
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: EventTypeTranslationRepository.upsertManyTitleTranslations
    EventTypeTranslation: defineFactory({
      create: async (data) => {
        const repo = new EventTypeTranslationRepository(db);
        await repo.upsertManyTitleTranslations([
          {
            eventTypeId: data.eventTypeId as number,
            userId: data.userId as number,
            sourceLocale: data.sourceLocale as never,
            targetLocale: data.targetLocale as never,
            translatedText: data.translatedText as string,
          },
        ]);
        const row = await db.eventTypeTranslation.findFirstOrThrow({
          where: {
            eventTypeId: data.eventTypeId as number,
            targetLocale: data.targetLocale as never,
          },
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: HolidayRepository.upsertUserSettings
    UserHolidaySettings: defineFactory({
      create: async (data) => {
        const row = await HolidayRepository.upsertUserSettings({
          userId: data.userId as number,
          countryCode: data.countryCode as string,
          disabledIds: (data.disabledIds as string[] | undefined) ?? [],
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: HolidayRepository.createManyCacheEntries
    HolidayCache: defineFactory({
      create: async (data) => {
        await HolidayRepository.createManyCacheEntries([
          {
            countryCode: data.countryCode as string,
            calendarId: data.calendarId as string,
            eventId: data.eventId as string,
            year: data.year as number,
            name: data.name as string,
            date:
              data.date instanceof Date
                ? data.date
                : new Date(data.date as string),
          },
        ]);
        const row = await db.holidayCache.findUniqueOrThrow({
          where: {
            countryCode_eventId: {
              countryCode: data.countryCode as string,
              eventId: data.eventId as string,
            },
          },
        });
        return asRef(row);
      },
    }),

    // audit.creation_function: scheduleTrigger
    WebhookScheduledTriggers: defineFactory({
      create: async (data) => {
        const row = await scheduleTrigger({
          booking: data.booking as never,
          subscriberUrl: data.subscriberUrl as string,
          subscriber: data.subscriber as never,
          triggerEvent: data.triggerEvent as never,
        } as never);
        return asRef(row as never);
      },
    }),

    // audit.creation_function: CalVideoSettingsRepository.createCalVideoSettings
    CalVideoSettings: defineFactory({
      create: async (data) => {
        const row = await CalVideoSettingsRepository.createCalVideoSettings({
          eventTypeId: data.eventTypeId as number,
          calVideoSettings: {
            disableRecordingForGuests:
              (data.disableRecordingForGuests as boolean | null | undefined) ?? null,
            disableRecordingForOrganizer:
              (data.disableRecordingForOrganizer as boolean | null | undefined) ?? null,
            enableAutomaticTranscription:
              (data.enableAutomaticTranscription as boolean | null | undefined) ?? null,
            enableAutomaticRecordingForOrganizer:
              (data.enableAutomaticRecordingForOrganizer as boolean | null | undefined) ?? null,
            disableTranscriptionForGuests:
              (data.disableTranscriptionForGuests as boolean | null | undefined) ?? null,
            disableTranscriptionForOrganizer:
              (data.disableTranscriptionForOrganizer as boolean | null | undefined) ?? null,
            redirectUrlOnExit: (data.redirectUrlOnExit as string | null | undefined) ?? null,
            requireEmailForGuests:
              (data.requireEmailForGuests as boolean | null | undefined) ?? null,
          },
        });
        return asRef(row);
      },
    }),

    // ------------------------------------------------------------
    // Tier C — NotImplemented stubs. Each stub names the audit's
    // creation_function in the comment above it so the fidelity
    // validator can see which function the factory stands in for.
    // ------------------------------------------------------------

    // audit.creation_function: updateHandler (prisma.hostGroup.create inside
    // event-type update transaction). Inline in trpc handler; scenarios don't
    // use it.
    HostGroup: defineFactory({
      create: async () => {
        throwNotImplemented("HostGroup", "inline in trpc eventTypes update transaction");
        return { id: undefined };
      },
    }),

    // audit.creation_function: HostLocationRepository.create — the repo
    // only exports upsertMany; scenarios don't use standalone HostLocation.
    HostLocation: defineFactory({
      create: async () => {
        throwNotImplemented(
          "HostLocation",
          "only upsertMany exported; the via-owner path fires inside EventType",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: VideoCallGuestRepository.create — the repo
    // only exports upsertVideoCallGuest; used via the booking flow.
    VideoCallGuest: defineFactory({
      create: async () => {
        throwNotImplemented(
          "VideoCallGuest",
          "only upsertVideoCallGuest exported; used via the booking flow",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: updateProfileHandler (prisma.travelSchedule.create).
    // Inline in trpc me.updateProfile handler.
    TravelSchedule: defineFactory({
      create: async () => {
        throwNotImplemented("TravelSchedule", "inline in trpc me.updateProfile handler");
        return { id: undefined };
      },
    }),

    // audit.creation_function: addNotificationsSubscriptionHandler.
    // Inline in trpc loggedInViewer handler.
    NotificationsSubscriptions: defineFactory({
      create: async () => {
        throwNotImplemented(
          "NotificationsSubscriptions",
          "inline in trpc loggedInViewer handler",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: TeamsRepository.create — lives in the
    // apps/api/v2 NestJS module and is not reachable from apps/web.
    Team: defineFactory({
      create: async () => {
        throwNotImplemented("Team", "lives in apps/api/v2 NestJS module");
        return { id: undefined };
      },
    }),

    // audit.creation_function: duplicateHandler (prisma.eventTypeCustomInput.create
    // inside duplicate transaction). Inline in trpc handler.
    EventTypeCustomInput: defineFactory({
      create: async () => {
        throwNotImplemented(
          "EventTypeCustomInput",
          "inline in trpc eventTypes.duplicate handler",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: GET handler (prisma.reminderMail.create inside
    // the cron loop). Inline in bookingReminder cron route.
    ReminderMail: defineFactory({
      create: async () => {
        throwNotImplemented("ReminderMail", "inline in bookingReminder cron route");
        return { id: undefined };
      },
    }),

    // audit.creation_function: PaymentService.create — Stripe-backed, needs
    // a real payment intent; no scenario exercises it.
    Payment: defineFactory({
      create: async () => {
        throwNotImplemented("Payment", "Stripe-backed, requires a real payment intent");
        return { id: undefined };
      },
    }),

    // audit.creation_function: createHandler (prisma.webhook.create in the
    // trpc viewer.webhook.create handler). Inline.
    Webhook: defineFactory({
      create: async () => {
        throwNotImplemented("Webhook", "inline in trpc viewer.webhook.create handler");
        return { id: undefined };
      },
    }),

    // audit.creation_function: createHandler (also PrismaApiKeyRepository.create).
    // Inline in trpc viewer.apiKeys.create.
    ApiKey: defineFactory({
      create: async () => {
        throwNotImplemented("ApiKey", "inline in trpc viewer.apiKeys.create handler");
        return { id: undefined };
      },
    }),

    // audit.creation_function: updateDeploymentSetupHandler (prisma.deployment.upsert
    // with id:1). Admin-only, effectively static per deployment.
    Deployment: defineFactory({
      create: async () => {
        throwNotImplemented("Deployment", "admin deployment setup, not user-scoped");
        return { id: undefined };
      },
    }),

    // audit.creation_function: reserveSlotHandler (prisma.selectedSlots.create).
    // Inline in trpc reserveSlot.
    SelectedSlots: defineFactory({
      create: async () => {
        throwNotImplemented("SelectedSlots", "inline in trpc reserveSlot handler");
        return { id: undefined };
      },
    }),

    // audit.creation_function: CalComAdapter.linkAccount (prisma.account.create).
    // Inline in next-auth custom adapter hook.
    Account: defineFactory({
      create: async () => {
        throwNotImplemented("Account", "inline in next-auth linkAccount adapter hook");
        return { id: undefined };
      },
    }),

    // audit.creation_function: PrismaFeatureRepository — feature flags are
    // seeded by Prisma migrations; no create method exists.
    Feature: defineFactory({
      create: async () => {
        throwNotImplemented("Feature", "seeded by Prisma migrations");
        return { id: undefined };
      },
    }),

    // audit.creation_function: PrismaUserFeatureRepository.create — the
    // repository only exposes upsert; admin flag management only.
    UserFeatures: defineFactory({
      create: async () => {
        throwNotImplemented(
          "UserFeatures",
          "admin flag management only exposes upsert, not create",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: PrismaTeamFeatureRepository.create — the
    // repository only exposes upsert; admin flag management only.
    TeamFeatures: defineFactory({
      create: async () => {
        throwNotImplemented(
          "TeamFeatures",
          "admin flag management only exposes upsert, not create",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: PrismaAppRepository.seedAppData / upsert —
    // seeded by app-store registration at install time.
    App: defineFactory({
      create: async () => {
        throwNotImplemented("App", "seeded by app-store registration");
        return { id: undefined };
      },
    }),

    // audit.creation_function: outOfOfficeCreateOrUpdateHandler
    // (prisma.outOfOfficeEntry.create). Inline in trpc ooo handler.
    OutOfOfficeEntry: defineFactory({
      create: async () => {
        throwNotImplemented("OutOfOfficeEntry", "inline in trpc ooo handler");
        return { id: undefined };
      },
    }),

    // audit.creation_function: addSecondaryEmailHandler (prisma.secondaryEmail.create).
    // Inline in trpc loggedInViewer.addSecondaryEmail.
    SecondaryEmail: defineFactory({
      create: async () => {
        throwNotImplemented("SecondaryEmail", "inline in trpc secondary-email handler");
        return { id: undefined };
      },
    }),

    // audit.creation_function: handleInternalNote (prisma.bookingInternalNote.create).
    // Inline in handleInternalNote helper.
    BookingInternalNote: defineFactory({
      create: async () => {
        throwNotImplemented("BookingInternalNote", "inline in handleInternalNote helper");
        return { id: undefined };
      },
    }),

    // audit.creation_function: RegularBookingService (prismaClient.bookingSeat.create
    // inside seated booking flow). Requires a Booking context.
    BookingSeat: defineFactory({
      create: async () => {
        throwNotImplemented("BookingSeat", "requires seated-booking context");
        return { id: undefined };
      },
    }),

    // audit.creation_function: OAuthClientRepository.createOAuthClient
    // (apps/api/v2) — lives in the NestJS module.
    PlatformOAuthClient: defineFactory({
      create: async () => {
        throwNotImplemented("PlatformOAuthClient", "lives in apps/api/v2 NestJS module");
        return { id: undefined };
      },
    }),

    // audit.creation_function: TokensRepository.createAuthorizationToken
    // (apps/api/v2) — lives in the NestJS module.
    PlatformAuthorizationToken: defineFactory({
      create: async () => {
        throwNotImplemented(
          "PlatformAuthorizationToken",
          "lives in apps/api/v2 NestJS module",
        );
        return { id: undefined };
      },
    }),

    // audit.creation_function: TokensRepository.createAccessToken
    // (apps/api/v2) — lives in the NestJS module.
    AccessToken: defineFactory({
      create: async () => {
        throwNotImplemented("AccessToken", "lives in apps/api/v2 NestJS module");
        return { id: undefined };
      },
    }),

    // audit.creation_function: TokensRepository.createRefreshToken
    // (apps/api/v2) — lives in the NestJS module.
    RefreshToken: defineFactory({
      create: async () => {
        throwNotImplemented("RefreshToken", "lives in apps/api/v2 NestJS module");
        return { id: undefined };
      },
    }),

    // audit.creation_function: WatchlistRepository.createEntry — creation
    // input is a typed union over organizationId/email pairings; no scenario
    // exercises watchlist.
    Watchlist: defineFactory({
      create: async () => {
        throwNotImplemented("Watchlist", "no scenario exercises watchlist");
        return { id: undefined };
      },
    }),

    // audit.creation_function: PrismaWatchlistAuditRepository.create — only
    // reached via Watchlist mutations; no scenario exercises watchlist audit.
    WatchlistAudit: defineFactory({
      create: async () => {
        throwNotImplemented("WatchlistAudit", "no scenario exercises watchlist audit");
        return { id: undefined };
      },
    }),
  },
  auth: async (user) => {
    if (!user || typeof user !== "object") {
      throw new Error("Autonoma auth callback: no User record was created in this up() call");
    }

    const userId = user.id;
    if (userId === undefined || userId === null) {
      throw new Error("Autonoma auth callback: created User is missing an id field");
    }

    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
      throw new Error(
        "Autonoma auth callback: NEXTAUTH_SECRET is not set. Cal.com uses a JWT session cookie " +
          "and the test runner cannot authenticate without it.",
      );
    }

    // Mirror the minimum JWT shape Cal.com's own jwt callback writes for a
    // credentials login (see packages/features/auth/lib/next-auth-options.ts,
    // callbacks.jwt, the account.type === "credentials" branch). Only a
    // subset is strictly required: sub (user id as string), email, id, name,
    // username, role, locale. autoMergeIdentities re-hydrates profileId /
    // upId on the next session read, so we can leave org undefined.
    const jwt = await encodeJwt({
      secret,
      maxAge: 24 * 60 * 60,
      token: {
        sub: String(userId),
        id: typeof userId === "number" ? userId : Number(userId),
        email: (user.email as string | null | undefined) ?? null,
        name: (user.name as string | null | undefined) ?? null,
        username: (user.username as string | null | undefined) ?? null,
        role: (user.role as "USER" | "ADMIN" | null | undefined) ?? "USER",
        locale: (user.locale as string | undefined) ?? "en",
        belongsToActiveTeam: false,
      },
    });

    // Cal.com uses next-auth.session-token in HTTP-dev and __Secure- prefix
    // in HTTPS-prod (see packages/lib/default-cookies.ts). Default to the
    // non-secure name so localhost E2E works out of the box; tests running
    // over HTTPS can read the cookie by both names (NextAuth checks both).
    const webappUrl = process.env.NEXT_PUBLIC_WEBAPP_URL ?? "http://localhost:3000";
    const useSecureCookies = webappUrl.startsWith("https://");
    const cookieName = `${useSecureCookies ? "__Secure-" : ""}next-auth.session-token`;

    return {
      cookies: [
        {
          name: cookieName,
          value: jwt,
          httpOnly: true,
          sameSite: useSecureCookies ? "none" : "lax",
          path: "/",
        },
      ],
    };
  },
});
