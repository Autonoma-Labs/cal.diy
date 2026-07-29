import { defineFactory } from "@autonoma-ai/sdk";
import { generateUniqueAPIKey } from "@calcom/features/api-keys-legacy/api-keys/lib/apiKeys";
import { PrismaAppRepository } from "@calcom/features/apps/repository/PrismaAppRepository";
import { DestinationCalendarRepository } from "@calcom/features/calendars/repositories/DestinationCalendarRepository";
import { CredentialRepository } from "@calcom/features/credentials/repositories/CredentialRepository";
import { CreditsRepository } from "@calcom/features/credits/repositories/CreditsRepository";
import type { AppFlags } from "@calcom/features/flags/config";
import { FeaturesRepository } from "@calcom/features/flags/features.repository";
import { AccessCodeRepository } from "@calcom/features/oauth/repositories/AccessCodeRepository";
import { OAuthClientRepository } from "@calcom/features/oauth/repositories/OAuthClientRepository";
import { SelectedCalendarRepository } from "@calcom/features/selectedCalendar/repositories/SelectedCalendarRepository";
import { TaskRepository } from "@calcom/features/tasker/repository";
import type { TaskTypes } from "@calcom/features/tasker/tasker";
import { prisma } from "@calcom/prisma";
import {
  AccessScope,
  AppCategories,
  CalendarCacheEventStatus,
  CreditType,
  CreditUsageType,
  FeatureType,
  OAuthClientStatus,
  PhoneNumberSubscriptionStatus,
  WebhookTriggerEvents,
} from "@calcom/prisma/enums";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { compositeId, safeDelete, splitCompositeId, toJsonValue } from "../helpers";

/**
 * `PrismaAppRepository.seedApp` is the app store's own installer: it looks the
 * app up in the generated metadata and derives slug, categories and the enabled
 * flag from it, so only `dirName` is seeded here.
 */
export const App = defineFactory({
  inputSchema: z.object({
    dirName: z.string(),
    keys: z.record(z.string(), z.unknown()).nullish(),
    /** Fallbacks used only when the app is absent from the generated metadata. */
    slug: z.string().optional(),
    categories: z.array(z.nativeEnum(AppCategories)).optional(),
    enabled: z.boolean().optional(),
  }),
  create: async (data) => {
    // App rows are instance-level and usually already seeded by the app store.
    // Adopting an existing row rather than failing, and remembering that we did
    // not create it, keeps teardown from deleting data that isn't ours.
    const existing = await prisma.app.findUnique({ where: { dirName: data.dirName } });
    if (existing) {
      return { id: existing.slug, slug: existing.slug, dirName: existing.dirName, preexisting: true };
    }

    try {
      await PrismaAppRepository.seedApp(data.dirName, data.keys ? toJsonValue(data.keys) : undefined);
      const app = await prisma.app.findUniqueOrThrow({ where: { dirName: data.dirName } });
      return { id: app.slug, slug: app.slug, dirName: app.dirName, preexisting: false };
    } catch {
      // `seedApp` throws when the dirName is absent from the generated app-store
      // metadata (community builds ship a subset). Fall back to the row shape.
      const app = await prisma.app.create({
        data: {
          slug: data.slug ?? data.dirName,
          dirName: data.dirName,
          categories: data.categories ?? [AppCategories.other],
          enabled: data.enabled ?? true,
          keys: data.keys ? toJsonValue(data.keys) : undefined,
        },
      });
      return { id: app.slug, slug: app.slug, dirName: app.dirName, preexisting: false };
    }
  },
  teardown: async (record) => {
    if (record.preexisting) return;
    await safeDelete(() => prisma.app.delete({ where: { slug: String(record.id) } }));
  },
});

export const Credential = defineFactory({
  inputSchema: z.object({
    type: z.string(),
    key: z.record(z.string(), z.unknown()),
    userId: z.number(),
    appId: z.string(),
  }),
  create: async (data) => {
    const credential = await CredentialRepository.create({
      type: data.type,
      key: data.key,
      userId: data.userId,
      appId: data.appId,
    });
    return { id: credential.id, type: credential.type, appId: credential.appId };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.credential.delete({ where: { id: Number(record.id) } })),
});

export const WorkspacePlatform = defineFactory({
  inputSchema: z.object({
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    defaultServiceAccountKey: z.record(z.string(), z.unknown()),
    enabled: z.boolean().optional(),
  }),
  create: async (data) => {
    const platform = await prisma.workspacePlatform.create({
      data: {
        slug: data.slug,
        name: data.name,
        description: data.description,
        defaultServiceAccountKey: toJsonValue(data.defaultServiceAccountKey),
        enabled: data.enabled,
      },
    });
    return { id: platform.id, slug: platform.slug };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.workspacePlatform.delete({ where: { id: Number(record.id) } })),
});

export const DelegationCredential = defineFactory({
  inputSchema: z.object({
    organizationId: z.number(),
    workspacePlatformId: z.number(),
    domain: z.string(),
    serviceAccountKey: z.record(z.string(), z.unknown()),
    enabled: z.boolean().optional(),
  }),
  create: async (data) => {
    const delegationCredential = await prisma.delegationCredential.create({
      data: {
        organizationId: data.organizationId,
        workspacePlatformId: data.workspacePlatformId,
        domain: data.domain,
        serviceAccountKey: toJsonValue(data.serviceAccountKey),
        enabled: data.enabled,
      },
    });
    return { id: delegationCredential.id, domain: delegationCredential.domain };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.delegationCredential.delete({ where: { id: String(record.id) } })),
});

export const SelectedCalendar = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    integration: z.string(),
    externalId: z.string(),
    credentialId: z.number().nullish(),
    eventTypeId: z.number().nullish(),
    delegationCredentialId: z.string().nullish(),
  }),
  create: async (data) => {
    const selectedCalendar = await SelectedCalendarRepository.create({
      userId: data.userId,
      integration: data.integration,
      externalId: data.externalId,
      credentialId: data.credentialId ?? undefined,
      eventTypeId: data.eventTypeId ?? undefined,
      delegationCredentialId: data.delegationCredentialId ?? undefined,
    });
    return { id: selectedCalendar.id, externalId: selectedCalendar.externalId };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.selectedCalendar.delete({ where: { id: String(record.id) } })),
});

export const DestinationCalendar = defineFactory({
  inputSchema: z.object({
    integration: z.string(),
    externalId: z.string(),
    userId: z.number(),
    credentialId: z.number().nullish(),
    eventTypeId: z.number().nullish(),
    primaryEmail: z.string().nullish(),
  }),
  create: async (data) => {
    const destinationCalendar = await DestinationCalendarRepository.createIfNotExistsForUser({
      integration: data.integration,
      externalId: data.externalId,
      userId: data.userId,
      credentialId: data.credentialId ?? undefined,
      eventTypeId: data.eventTypeId ?? undefined,
      primaryEmail: data.primaryEmail ?? undefined,
    });
    return { id: destinationCalendar.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.destinationCalendar.delete({ where: { id: Number(record.id) } })),
});

/** Primary key is (credentialId, key); the cache is written by the sync jobs. */
export const CalendarCache = defineFactory({
  inputSchema: z.object({
    credentialId: z.number(),
    key: z.string(),
    value: z.record(z.string(), z.unknown()),
    expiresAt: z.coerce.date(),
    userId: z.number().nullish(),
  }),
  create: async (data) => {
    const cache = await prisma.calendarCache.create({
      data: {
        credentialId: data.credentialId,
        key: data.key,
        value: toJsonValue(data.value),
        expiresAt: data.expiresAt,
        userId: data.userId ?? undefined,
      },
    });
    return { id: compositeId(cache.credentialId, cache.key) };
  },
  teardown: async (record) => {
    const [credentialId, ...keyParts] = splitCompositeId(record.id);
    await safeDelete(() =>
      prisma.calendarCache.delete({
        where: { credentialId_key: { credentialId: Number(credentialId), key: keyParts.join("::") } },
      })
    );
  },
});

/**
 * `CalendarCacheEventRepository` only exposes a batch `upsertMany` that expects
 * fully-materialized rows and returns settled promises, so the single-row upsert
 * it performs is replicated here to get the id back.
 */
export const CalendarCacheEvent = defineFactory({
  inputSchema: z.object({
    selectedCalendarId: z.string(),
    externalId: z.string(),
    externalEtag: z.string(),
    start: z.coerce.date(),
    end: z.coerce.date(),
    summary: z.string().nullish(),
    description: z.string().nullish(),
    location: z.string().nullish(),
    timeZone: z.string().nullish(),
    isAllDay: z.boolean().optional(),
    status: z.nativeEnum(CalendarCacheEventStatus).optional(),
    iCalUID: z.string().nullish(),
  }),
  create: async (data) => {
    const event = await prisma.calendarCacheEvent.upsert({
      where: {
        selectedCalendarId_externalId: {
          selectedCalendarId: data.selectedCalendarId,
          externalId: data.externalId,
        },
      },
      update: { start: data.start, end: data.end, externalEtag: data.externalEtag },
      create: {
        selectedCalendarId: data.selectedCalendarId,
        externalId: data.externalId,
        externalEtag: data.externalEtag,
        start: data.start,
        end: data.end,
        summary: data.summary ?? undefined,
        description: data.description ?? undefined,
        location: data.location ?? undefined,
        timeZone: data.timeZone ?? undefined,
        isAllDay: data.isAllDay,
        status: data.status,
        iCalUID: data.iCalUID ?? undefined,
      },
    });
    return { id: event.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.calendarCacheEvent.delete({ where: { id: String(record.id) } })),
});

/** Mirrors the insert in `viewer/webhook/create.handler`. */
export const Webhook = defineFactory({
  inputSchema: z.object({
    id: z.string(),
    subscriberUrl: z.string(),
    eventTriggers: z.array(z.nativeEnum(WebhookTriggerEvents)),
    active: z.boolean().optional(),
    userId: z.number().nullish(),
    teamId: z.number().nullish(),
    eventTypeId: z.number().nullish(),
    platformOAuthClientId: z.string().nullish(),
    payloadTemplate: z.string().nullish(),
    secret: z.string().nullish(),
    appId: z.string().nullish(),
  }),
  create: async (data) => {
    const webhook = await prisma.webhook.create({
      data: {
        id: data.id,
        subscriberUrl: data.subscriberUrl,
        eventTriggers: data.eventTriggers,
        active: data.active,
        userId: data.userId ?? undefined,
        teamId: data.teamId ?? undefined,
        eventTypeId: data.eventTypeId ?? undefined,
        platformOAuthClientId: data.platformOAuthClientId ?? undefined,
        payloadTemplate: data.payloadTemplate ?? undefined,
        secret: data.secret ?? undefined,
        appId: data.appId ?? undefined,
      },
    });
    return { id: webhook.id, subscriberUrl: webhook.subscriberUrl };
  },
  teardown: async (record) => safeDelete(() => prisma.webhook.delete({ where: { id: String(record.id) } })),
});

/** Mirrors the insert in `packages/features/webhooks/lib/scheduleTrigger.ts`. */
export const WebhookScheduledTriggers = defineFactory({
  inputSchema: z.object({
    subscriberUrl: z.string(),
    payload: z.string(),
    startAfter: z.coerce.date(),
    webhookId: z.string().nullish(),
    bookingId: z.number().nullish(),
    appId: z.string().nullish(),
  }),
  create: async (data) => {
    const trigger = await prisma.webhookScheduledTriggers.create({
      data: {
        subscriberUrl: data.subscriberUrl,
        payload: data.payload,
        startAfter: data.startAfter,
        webhookId: data.webhookId ?? undefined,
        bookingId: data.bookingId ?? undefined,
        appId: data.appId ?? undefined,
      },
    });
    return { id: trigger.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.webhookScheduledTriggers.delete({ where: { id: Number(record.id) } })),
});

/**
 * `PrismaApiKeyRepository.createApiKey` returns only the plaintext key, so the
 * row id needed for teardown is unreachable through it. This is the insert from
 * `viewer/apiKeys/create.handler`, still hashing through the app's own
 * `generateUniqueAPIKey`, so no plaintext key ends up in the recipe.
 */
export const ApiKey = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    note: z.string().nullish(),
    teamId: z.number().nullish(),
    expiresAt: z.coerce.date().nullish(),
    appId: z.string().nullish(),
  }),
  create: async (data) => {
    const [hashedApiKey] = generateUniqueAPIKey();
    const apiKey = await prisma.apiKey.create({
      data: {
        id: uuidv4(),
        userId: data.userId,
        teamId: data.teamId ?? undefined,
        note: data.note ?? undefined,
        expiresAt: data.expiresAt ?? null,
        appId: data.appId ?? undefined,
        hashedKey: hashedApiKey,
      },
    });
    return { id: apiKey.id };
  },
  teardown: async (record) => safeDelete(() => prisma.apiKey.delete({ where: { id: String(record.id) } })),
});

export const RateLimit = defineFactory({
  inputSchema: z.object({
    apiKeyId: z.string(),
    name: z.string(),
    limit: z.number(),
    ttl: z.number(),
    blockDuration: z.number(),
  }),
  create: async (data) => {
    const rateLimit = await prisma.rateLimit.create({ data });
    return { id: rateLimit.id };
  },
  teardown: async (record) => safeDelete(() => prisma.rateLimit.delete({ where: { id: String(record.id) } })),
});

/** Same shape the feature-flag seed migrations insert. */
export const Feature = defineFactory({
  inputSchema: z.object({
    slug: z.string(),
    enabled: z.boolean().optional(),
    description: z.string().nullish(),
    type: z.nativeEnum(FeatureType).optional(),
    stale: z.boolean().optional(),
  }),
  create: async (data) => {
    // Feature flags are instance-level and seeded by migrations, so an existing
    // row is adopted read-only and left alone on teardown.
    const existing = await prisma.feature.findUnique({ where: { slug: data.slug } });
    if (existing) return { id: existing.slug, slug: existing.slug, preexisting: true };

    const feature = await prisma.feature.create({
      data: {
        slug: data.slug,
        enabled: data.enabled,
        description: data.description ?? undefined,
        type: data.type,
        stale: data.stale,
      },
    });
    return { id: feature.slug, slug: feature.slug, preexisting: false };
  },
  teardown: async (record) => {
    if (record.preexisting) return;
    await safeDelete(() => prisma.feature.delete({ where: { slug: String(record.id) } }));
  },
});

export const UserFeatures = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    featureId: z.string(),
    enabled: z.boolean(),
    assignedBy: z.string(),
  }),
  create: async (data) => {
    const featuresRepository = new FeaturesRepository(prisma);
    await featuresRepository.setUserFeatureState({
      userId: data.userId,
      // The repository narrows featureId to the known flag union; a seeded flag
      // slug is validated at runtime by the Feature row it references.
      featureId: data.featureId as keyof AppFlags,
      state: data.enabled ? "enabled" : "disabled",
      assignedBy: data.assignedBy,
    });
    return { id: compositeId(data.userId, data.featureId) };
  },
  teardown: async (record) => {
    const [userId, featureId] = splitCompositeId(record.id);
    await safeDelete(() =>
      prisma.userFeatures.delete({
        where: { userId_featureId: { userId: Number(userId), featureId } },
      })
    );
  },
});

export const TeamFeatures = defineFactory({
  inputSchema: z.object({
    teamId: z.number(),
    featureId: z.string(),
    enabled: z.boolean(),
    assignedBy: z.string(),
  }),
  create: async (data) => {
    const featuresRepository = new FeaturesRepository(prisma);
    await featuresRepository.setTeamFeatureState({
      teamId: data.teamId,
      featureId: data.featureId as keyof AppFlags,
      state: data.enabled ? "enabled" : "disabled",
      assignedBy: data.assignedBy,
    });
    return { id: compositeId(data.teamId, data.featureId) };
  },
  teardown: async (record) => {
    const [teamId, featureId] = splitCompositeId(record.id);
    await safeDelete(() =>
      prisma.teamFeatures.delete({
        where: { teamId_featureId: { teamId: Number(teamId), featureId } },
      })
    );
  },
});

/** Single-row table; mirrors the upsert in `viewer/deploymentSetup/update.handler`. */
export const Deployment = defineFactory({
  inputSchema: z.object({
    id: z.number().optional(),
    licenseKey: z.string().nullish(),
    agreedLicenseAt: z.coerce.date().nullish(),
  }),
  create: async (data) => {
    const id = data.id ?? 1;
    // Instance-level singleton: an existing deployment row belongs to the
    // environment, not to this test run, so it is neither modified nor removed.
    const existing = await prisma.deployment.findUnique({ where: { id } });
    if (existing) return { id: existing.id, preexisting: true };

    const deployment = await prisma.deployment.create({
      data: {
        id,
        licenseKey: data.licenseKey ?? undefined,
        agreedLicenseAt: data.agreedLicenseAt ?? undefined,
      },
    });
    return { id: deployment.id, preexisting: false };
  },
  teardown: async (record) => {
    if (record.preexisting) return;
    await safeDelete(() => prisma.deployment.delete({ where: { id: Number(record.id) } }));
  },
});

export const CreditBalance = defineFactory({
  inputSchema: z.object({
    teamId: z.number().nullish(),
    userId: z.number().nullish(),
    additionalCredits: z.number().optional(),
  }),
  create: async (data) => {
    const balance = await CreditsRepository.createCreditBalance({
      teamId: data.teamId ?? undefined,
      userId: data.userId ?? undefined,
      additionalCredits: data.additionalCredits,
    });
    return { id: balance.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.creditBalance.delete({ where: { id: String(record.id) } })),
});

export const CreditPurchaseLog = defineFactory({
  inputSchema: z.object({
    creditBalanceId: z.string(),
    credits: z.number(),
  }),
  create: async (data) => {
    const log = await CreditsRepository.createCreditPurchaseLog(data);
    return { id: log.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.creditPurchaseLog.delete({ where: { id: String(record.id) } })),
});

export const CreditExpenseLog = defineFactory({
  inputSchema: z.object({
    creditBalanceId: z.string(),
    creditType: z.nativeEnum(CreditType),
    date: z.coerce.date(),
    credits: z.number().nullish(),
    creditFor: z.nativeEnum(CreditUsageType).nullish(),
    bookingUid: z.string().nullish(),
    smsSid: z.string().nullish(),
    smsSegments: z.number().nullish(),
    phoneNumber: z.string().nullish(),
    email: z.string().nullish(),
    externalRef: z.string().nullish(),
  }),
  create: async (data) => {
    const log = await CreditsRepository.createCreditExpenseLog({
      creditBalanceId: data.creditBalanceId,
      creditType: data.creditType,
      date: data.date,
      credits: data.credits ?? undefined,
      creditFor: data.creditFor ?? undefined,
      bookingUid: data.bookingUid ?? undefined,
      smsSid: data.smsSid ?? undefined,
      smsSegments: data.smsSegments ?? undefined,
      phoneNumber: data.phoneNumber ?? undefined,
      email: data.email ?? undefined,
      externalRef: data.externalRef ?? undefined,
    });
    return { id: log.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.creditExpenseLog.delete({ where: { id: String(record.id) } })),
});

export const PlatformOAuthClient = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    secret: z.string(),
    permissions: z.number(),
    organizationId: z.number(),
    redirectUris: z.array(z.string()).optional(),
    logo: z.string().nullish(),
    areEmailsEnabled: z.boolean().optional(),
  }),
  create: async (data) => {
    const client = await prisma.platformOAuthClient.create({
      data: {
        name: data.name,
        secret: data.secret,
        permissions: data.permissions,
        organizationId: data.organizationId,
        redirectUris: data.redirectUris ?? [],
        logo: data.logo ?? undefined,
        areEmailsEnabled: data.areEmailsEnabled,
      },
    });
    return { id: client.id, name: client.name };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.platformOAuthClient.delete({ where: { id: String(record.id) } })),
});

export const PlatformAuthorizationToken = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    platformOAuthClientId: z.string(),
  }),
  create: async (data) => {
    const token = await prisma.platformAuthorizationToken.create({ data });
    return { id: token.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.platformAuthorizationToken.delete({ where: { id: String(record.id) } })),
});

export const AccessToken = defineFactory({
  inputSchema: z.object({
    secret: z.string(),
    userId: z.number(),
    platformOAuthClientId: z.string(),
    expiresAt: z.coerce.date(),
  }),
  create: async (data) => {
    const token = await prisma.accessToken.create({ data });
    return { id: token.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.accessToken.delete({ where: { id: Number(record.id) } })),
});

export const RefreshToken = defineFactory({
  inputSchema: z.object({
    secret: z.string(),
    userId: z.number(),
    platformOAuthClientId: z.string(),
    expiresAt: z.coerce.date(),
  }),
  create: async (data) => {
    const token = await prisma.refreshToken.create({ data });
    return { id: token.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.refreshToken.delete({ where: { id: Number(record.id) } })),
});

export const OAuthClient = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    redirectUri: z.string(),
    purpose: z.string().optional(),
    clientSecret: z.string().nullish(),
    logo: z.string().nullish(),
    websiteUrl: z.string().nullish(),
    enablePkce: z.boolean().optional(),
    userId: z.number().nullish(),
    status: z.nativeEnum(OAuthClientStatus).optional(),
  }),
  create: async (data) => {
    const repository = new OAuthClientRepository(prisma);
    const client = await repository.create({
      name: data.name,
      purpose: data.purpose ?? "Seeded by Autonoma",
      redirectUri: data.redirectUri,
      clientSecret: data.clientSecret ?? undefined,
      logo: data.logo ?? undefined,
      websiteUrl: data.websiteUrl ?? undefined,
      enablePkce: data.enablePkce,
      userId: data.userId ?? undefined,
      status: data.status ?? OAuthClientStatus.APPROVED,
    });
    return { id: client.clientId, clientId: client.clientId };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.oAuthClient.delete({ where: { clientId: String(record.id) } })),
});

/**
 * `AccessCodeRepository.create` owns the 10-minute expiry and returns void, so
 * the row is read back to get its id. The repository's own `findValidCode` does
 * not select `id`, hence the direct read here.
 */
export const AccessCode = defineFactory({
  inputSchema: z.object({
    code: z.string(),
    clientId: z.string(),
    scopes: z.array(z.nativeEnum(AccessScope)),
    userId: z.number().nullish(),
    teamId: z.number().nullish(),
  }),
  create: async (data) => {
    const repository = new AccessCodeRepository(prisma);
    await repository.create({
      code: data.code,
      clientId: data.clientId,
      scopes: data.scopes,
      userId: data.userId ?? undefined,
      teamId: data.teamId ?? undefined,
    });
    const created = await prisma.accessCode.findFirst({
      where: { code: data.code, clientId: data.clientId },
      select: { id: true },
    });
    if (!created) throw new Error(`AccessCode ${data.code} was not persisted`);
    return { id: created.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.accessCode.delete({ where: { id: Number(record.id) } })),
});

export const Task = defineFactory({
  inputSchema: z.object({
    type: z.string(),
    payload: z.string(),
    scheduledAt: z.coerce.date().nullish(),
    maxAttempts: z.number().nullish(),
    referenceUid: z.string().nullish(),
  }),
  create: async (data) => {
    const repository = new TaskRepository({ prismaClient: prisma });
    const id = await repository.create(
      // The tasker's create is generic over the registered task names; the
      // recipe seeds one of them as a plain string.
      data.type as TaskTypes,
      data.payload,
      {
        scheduledAt: data.scheduledAt ?? undefined,
        maxAttempts: data.maxAttempts ?? undefined,
        referenceUid: data.referenceUid ?? undefined,
      }
    );
    return { id };
  },
  teardown: async (record) => safeDelete(() => prisma.task.delete({ where: { id: String(record.id) } })),
});

export const Agent = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    providerAgentId: z.string(),
    userId: z.number().nullish(),
    teamId: z.number().nullish(),
    inboundEventTypeId: z.number().nullish(),
    outboundEventTypeId: z.number().nullish(),
    enabled: z.boolean().optional(),
  }),
  create: async (data) => {
    const agent = await prisma.agent.create({
      data: {
        name: data.name,
        providerAgentId: data.providerAgentId,
        userId: data.userId ?? undefined,
        teamId: data.teamId ?? undefined,
        inboundEventTypeId: data.inboundEventTypeId ?? undefined,
        outboundEventTypeId: data.outboundEventTypeId ?? undefined,
        enabled: data.enabled,
      },
    });
    return { id: agent.id };
  },
  teardown: async (record) => safeDelete(() => prisma.agent.delete({ where: { id: String(record.id) } })),
});

export const CalAiPhoneNumber = defineFactory({
  inputSchema: z.object({
    phoneNumber: z.string(),
    provider: z.string(),
    userId: z.number().nullish(),
    teamId: z.number().nullish(),
    providerPhoneNumberId: z.string().nullish(),
    inboundAgentId: z.string().nullish(),
    outboundAgentId: z.string().nullish(),
    subscriptionStatus: z.nativeEnum(PhoneNumberSubscriptionStatus).nullish(),
  }),
  create: async (data) => {
    const phoneNumber = await prisma.calAiPhoneNumber.create({
      data: {
        phoneNumber: data.phoneNumber,
        provider: data.provider,
        userId: data.userId ?? undefined,
        teamId: data.teamId ?? undefined,
        providerPhoneNumberId: data.providerPhoneNumberId ?? undefined,
        inboundAgentId: data.inboundAgentId ?? undefined,
        outboundAgentId: data.outboundAgentId ?? undefined,
        subscriptionStatus: data.subscriptionStatus ?? undefined,
      },
    });
    return { id: phoneNumber.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.calAiPhoneNumber.delete({ where: { id: Number(record.id) } })),
});
