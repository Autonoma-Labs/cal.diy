import { defineFactory } from "@autonoma-ai/sdk";
import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { hashPassword } from "@calcom/lib/auth/hashPassword";
import { prisma } from "@calcom/prisma";
import { CreationSource, FilterSegmentScope, IdentityProvider, MembershipRole } from "@calcom/prisma/enums";
import { z } from "zod";
import { safeDelete, timeOnly, toJsonValue } from "../helpers";

/**
 * `UserRepository.create` is the path signup itself uses. It also mints the
 * default Schedule + its Availability rows (and a Profile when
 * organizationId + username are both set), so the recipe deliberately leaves
 * organizationId null here and creates Profiles through their own factory.
 */
export const User = defineFactory({
  inputSchema: z.object({
    email: z.string(),
    username: z.string().nullish(),
    name: z.string().nullish(),
    organizationId: z.number().nullish(),
    timeZone: z.string().optional(),
    locale: z.string().nullish(),
    role: z.enum(["USER", "ADMIN"]).optional(),
    completedOnboarding: z.boolean().optional(),
    emailVerified: z.coerce.date().nullish(),
    identityProvider: z.nativeEnum(IdentityProvider).optional(),
    weekStart: z.string().optional(),
    timeFormat: z.number().nullish(),
    bio: z.string().nullish(),
    locked: z.boolean().optional(),
    creationSource: z.nativeEnum(CreationSource).optional(),
  }),
  create: async (data) => {
    const userRepository = new UserRepository(prisma);
    const user = await userRepository.create({
      email: data.email,
      username: data.username ?? null,
      name: data.name ?? undefined,
      organizationId: data.organizationId ?? null,
      timeZone: data.timeZone,
      locale: data.locale ?? undefined,
      role: data.role,
      completedOnboarding: data.completedOnboarding ?? true,
      // Verified by default: an unverified user is bounced out of most flows.
      emailVerified: data.emailVerified ?? new Date(),
      identityProvider: data.identityProvider,
      weekStart: data.weekStart,
      timeFormat: data.timeFormat ?? undefined,
      bio: data.bio ?? undefined,
      locked: data.locked ?? false,
      creationSource: data.creationSource ?? CreationSource.WEBAPP,
    });
    return { id: user.id, uuid: user.uuid, email: user.email, username: user.username, name: user.name };
  },
  // Deleting the user cascades their schedules, availability, event types,
  // bookings, credentials, memberships, profiles and tokens.
  teardown: async (record) => safeDelete(() => prisma.user.delete({ where: { id: Number(record.id) } })),
});

/**
 * Takes the plaintext password and hashes it with the app's own hasher (the
 * upsert mirrors `viewer/auth/changePassword.handler`), so the credentials the
 * auth callback hands back really do log in.
 */
export const UserPassword = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    password: z.string(),
  }),
  create: async (data) => {
    const hash = await hashPassword(data.password);
    await prisma.userPassword.upsert({
      where: { userId: data.userId },
      update: { hash },
      create: { userId: data.userId, hash },
    });
    return { id: data.userId };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.userPassword.delete({ where: { userId: Number(record.id) } })),
});

export const Profile = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    organizationId: z.number(),
    username: z.string().nullish(),
    email: z.string(),
  }),
  create: async (data) => {
    const profile = await ProfileRepository.create({
      userId: data.userId,
      organizationId: data.organizationId,
      username: data.username ?? null,
      email: data.email,
    });
    return { id: profile.id, uid: profile.uid, username: profile.username };
  },
  teardown: async (record) => safeDelete(() => prisma.profile.delete({ where: { id: Number(record.id) } })),
});

export const Membership = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    teamId: z.number(),
    role: z.nativeEnum(MembershipRole),
    accepted: z.boolean().optional(),
    customRoleId: z.string().nullish(),
  }),
  create: async (data) => {
    const membership = await MembershipRepository.create({
      userId: data.userId,
      teamId: data.teamId,
      role: data.role,
      accepted: data.accepted ?? true,
    });
    // `MembershipRepository.create` has no customRoleId parameter, so the PBAC
    // link is attached afterwards rather than by bypassing the repository.
    if (data.customRoleId) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { customRoleId: data.customRoleId },
      });
    }
    return { id: membership.id, userId: membership.userId, teamId: membership.teamId };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.membership.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors `loggedInViewer/addSecondaryEmail.handler`. */
export const SecondaryEmail = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    email: z.string(),
    emailVerified: z.coerce.date().nullish(),
  }),
  create: async (data) => {
    const secondaryEmail = await prisma.secondaryEmail.create({
      data: {
        userId: data.userId,
        email: data.email,
        emailVerified: data.emailVerified ?? undefined,
      },
    });
    return { id: secondaryEmail.id, email: secondaryEmail.email };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.secondaryEmail.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors `viewer/availability/schedule/create.handler`. */
export const Schedule = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    name: z.string(),
    timeZone: z.string().nullish(),
    /** Set this schedule as the user's default, like the create handler does. */
    setAsDefault: z.boolean().optional(),
  }),
  create: async (data) => {
    const schedule = await prisma.schedule.create({
      data: {
        userId: data.userId,
        name: data.name,
        timeZone: data.timeZone ?? undefined,
      },
    });
    if (data.setAsDefault) {
      await prisma.user.update({
        where: { id: data.userId },
        data: { defaultScheduleId: schedule.id },
      });
    }
    return { id: schedule.id, userId: schedule.userId };
  },
  teardown: async (record) => safeDelete(() => prisma.schedule.delete({ where: { id: Number(record.id) } })),
});

/**
 * The app only ever writes Availability nested inside a Schedule create, so the
 * insert is replicated here. `startTime`/`endTime` are time-only columns, hence
 * "HH:mm" input mapped onto the epoch date.
 */
export const Availability = defineFactory({
  inputSchema: z.object({
    scheduleId: z.number().nullish(),
    userId: z.number().nullish(),
    eventTypeId: z.number().nullish(),
    days: z.array(z.number()),
    startTime: z.string(),
    endTime: z.string(),
    date: z.coerce.date().nullish(),
  }),
  create: async (data) => {
    const availability = await prisma.availability.create({
      data: {
        scheduleId: data.scheduleId ?? undefined,
        userId: data.userId ?? undefined,
        eventTypeId: data.eventTypeId ?? undefined,
        days: data.days,
        startTime: timeOnly(data.startTime),
        endTime: timeOnly(data.endTime),
        date: data.date ?? undefined,
      },
    });
    return { id: availability.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.availability.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors the createMany in `viewer/me/updateProfile.handler`. */
export const TravelSchedule = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    timeZone: z.string(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date().nullish(),
    prevTimeZone: z.string().nullish(),
  }),
  create: async (data) => {
    const travelSchedule = await prisma.travelSchedule.create({
      data: {
        userId: data.userId,
        timeZone: data.timeZone,
        startDate: data.startDate,
        endDate: data.endDate ?? undefined,
        prevTimeZone: data.prevTimeZone ?? undefined,
      },
    });
    return { id: travelSchedule.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.travelSchedule.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors `loggedInViewer/addNotificationsSubscription.handler`. */
export const NotificationsSubscriptions = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    subscription: z.string(),
  }),
  create: async (data) => {
    const subscription = await prisma.notificationsSubscriptions.create({ data });
    return { id: subscription.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.notificationsSubscriptions.delete({ where: { id: Number(record.id) } })),
});

export const UserHolidaySettings = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    countryCode: z.string().nullish(),
    disabledIds: z.array(z.string()).optional(),
  }),
  create: async (data) => {
    const settings = await prisma.userHolidaySettings.upsert({
      where: { userId: data.userId },
      update: { countryCode: data.countryCode ?? undefined, disabledIds: data.disabledIds },
      create: {
        userId: data.userId,
        countryCode: data.countryCode ?? undefined,
        disabledIds: data.disabledIds,
      },
    });
    return { id: settings.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.userHolidaySettings.delete({ where: { id: Number(record.id) } })),
});

export const HolidayCache = defineFactory({
  inputSchema: z.object({
    countryCode: z.string(),
    calendarId: z.string(),
    eventId: z.string(),
    name: z.string(),
    date: z.coerce.date(),
    year: z.number(),
  }),
  create: async (data) => {
    const holiday = await prisma.holidayCache.create({ data });
    return { id: holiday.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.holidayCache.delete({ where: { id: String(record.id) } })),
});

export const OutOfOfficeReason = defineFactory({
  inputSchema: z.object({
    reason: z.string(),
    emoji: z.string(),
    enabled: z.boolean().optional(),
    userId: z.number().nullish(),
  }),
  create: async (data) => {
    const reason = await prisma.outOfOfficeReason.create({
      data: {
        reason: data.reason,
        emoji: data.emoji,
        enabled: data.enabled,
        userId: data.userId ?? undefined,
      },
    });
    return { id: reason.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.outOfOfficeReason.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors the upsert in `viewer/ooo/outOfOfficeCreateOrUpdate.handler`. */
export const OutOfOfficeEntry = defineFactory({
  inputSchema: z.object({
    uuid: z.string(),
    userId: z.number(),
    start: z.coerce.date(),
    end: z.coerce.date(),
    toUserId: z.number().nullish(),
    reasonId: z.number().nullish(),
    notes: z.string().nullish(),
    showNotePublicly: z.boolean().optional(),
  }),
  create: async (data) => {
    const entry = await prisma.outOfOfficeEntry.create({
      data: {
        uuid: data.uuid,
        userId: data.userId,
        start: data.start,
        end: data.end,
        toUserId: data.toUserId ?? undefined,
        reasonId: data.reasonId ?? undefined,
        notes: data.notes ?? undefined,
        showNotePublicly: data.showNotePublicly,
      },
    });
    return { id: entry.id, uuid: entry.uuid };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.outOfOfficeEntry.delete({ where: { id: Number(record.id) } })),
});

export const VerifiedNumber = defineFactory({
  inputSchema: z.object({
    phoneNumber: z.string(),
    userId: z.number().nullish(),
    teamId: z.number().nullish(),
  }),
  create: async (data) => {
    const verified = await prisma.verifiedNumber.create({
      data: {
        phoneNumber: data.phoneNumber,
        userId: data.userId ?? undefined,
        teamId: data.teamId ?? undefined,
      },
    });
    return { id: verified.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.verifiedNumber.delete({ where: { id: Number(record.id) } })),
});

export const VerifiedEmail = defineFactory({
  inputSchema: z.object({
    email: z.string(),
    userId: z.number().nullish(),
    teamId: z.number().nullish(),
  }),
  create: async (data) => {
    const verified = await prisma.verifiedEmail.create({
      data: {
        email: data.email,
        userId: data.userId ?? undefined,
        teamId: data.teamId ?? undefined,
      },
    });
    return { id: verified.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.verifiedEmail.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors the insert in `packages/features/auth/lib/verifyEmail.ts`. */
export const VerificationToken = defineFactory({
  inputSchema: z.object({
    identifier: z.string(),
    token: z.string(),
    expires: z.coerce.date(),
    expiresInDays: z.number().nullish(),
    teamId: z.number().nullish(),
    secondaryEmailId: z.number().nullish(),
  }),
  create: async (data) => {
    const token = await prisma.verificationToken.create({
      data: {
        identifier: data.identifier,
        token: data.token,
        expires: data.expires,
        expiresInDays: data.expiresInDays ?? undefined,
        teamId: data.teamId ?? undefined,
        secondaryEmailId: data.secondaryEmailId ?? undefined,
      },
    });
    return { id: token.id, token: token.token };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.verificationToken.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors the insert in `packages/features/auth/lib/passwordResetRequest.ts`. */
export const ResetPasswordRequest = defineFactory({
  inputSchema: z.object({
    email: z.string(),
    expires: z.coerce.date(),
  }),
  create: async (data) => {
    const request = await prisma.resetPasswordRequest.create({ data });
    return { id: request.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.resetPasswordRequest.delete({ where: { id: String(record.id) } })),
});

/**
 * NextAuth is configured with `strategy: "jwt"`, so this table is only written
 * by the database-session code path in the custom adapter. Seeded for coverage.
 */
export const Session = defineFactory({
  inputSchema: z.object({
    sessionToken: z.string(),
    userId: z.number(),
    expires: z.coerce.date(),
  }),
  create: async (data) => {
    const session = await prisma.session.create({ data });
    return { id: session.id };
  },
  teardown: async (record) => safeDelete(() => prisma.session.delete({ where: { id: String(record.id) } })),
});

/** Mirrors `createAccountData` in `packages/features/auth/lib/next-auth-custom-adapter.ts`. */
export const Account = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    type: z.string(),
    provider: z.string(),
    providerAccountId: z.string(),
    providerEmail: z.string().nullish(),
    access_token: z.string().nullish(),
    refresh_token: z.string().nullish(),
    scope: z.string().nullish(),
    token_type: z.string().nullish(),
    expires_at: z.number().nullish(),
  }),
  create: async (data) => {
    const account = await prisma.account.create({
      data: {
        userId: data.userId,
        type: data.type,
        provider: data.provider,
        providerAccountId: data.providerAccountId,
        providerEmail: data.providerEmail ?? undefined,
        access_token: data.access_token ?? undefined,
        refresh_token: data.refresh_token ?? undefined,
        scope: data.scope ?? undefined,
        token_type: data.token_type ?? undefined,
        expires_at: data.expires_at ?? undefined,
      },
    });
    return { id: account.id };
  },
  teardown: async (record) => safeDelete(() => prisma.account.delete({ where: { id: String(record.id) } })),
});

export const Feedback = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    rating: z.string(),
    comment: z.string().nullish(),
  }),
  create: async (data) => {
    const feedback = await prisma.feedback.create({
      data: {
        userId: data.userId,
        rating: data.rating,
        comment: data.comment ?? undefined,
      },
    });
    return { id: feedback.id };
  },
  teardown: async (record) => safeDelete(() => prisma.feedback.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors the insert in `packages/features/data-table/repositories/filterSegment.ts`. */
export const FilterSegment = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    tableIdentifier: z.string(),
    scope: z.nativeEnum(FilterSegmentScope),
    perPage: z.number(),
    userId: z.number(),
    teamId: z.number().nullish(),
    activeFilters: z.array(z.unknown()).nullish(),
    sorting: z.array(z.unknown()).nullish(),
    searchTerm: z.string().nullish(),
  }),
  create: async (data) => {
    const segment = await prisma.filterSegment.create({
      data: {
        name: data.name,
        tableIdentifier: data.tableIdentifier,
        scope: data.scope,
        perPage: data.perPage,
        userId: data.userId,
        teamId: data.teamId ?? undefined,
        activeFilters: data.activeFilters ? toJsonValue(data.activeFilters) : undefined,
        sorting: data.sorting ? toJsonValue(data.sorting) : undefined,
        searchTerm: data.searchTerm ?? undefined,
      },
    });
    return { id: segment.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.filterSegment.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors the upsert in the same filterSegment repository. */
export const UserFilterSegmentPreference = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    tableIdentifier: z.string(),
    segmentId: z.number().nullish(),
    systemSegmentId: z.string().nullish(),
  }),
  create: async (data) => {
    const preference = await prisma.userFilterSegmentPreference.upsert({
      where: {
        userId_tableIdentifier: { userId: data.userId, tableIdentifier: data.tableIdentifier },
      },
      update: {
        segmentId: data.segmentId ?? null,
        systemSegmentId: data.systemSegmentId ?? null,
      },
      create: {
        userId: data.userId,
        tableIdentifier: data.tableIdentifier,
        segmentId: data.segmentId ?? undefined,
        systemSegmentId: data.systemSegmentId ?? undefined,
      },
    });
    return { id: preference.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.userFilterSegmentPreference.delete({ where: { id: Number(record.id) } })),
});
