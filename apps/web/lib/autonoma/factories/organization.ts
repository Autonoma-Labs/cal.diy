import { defineFactory } from "@autonoma-ai/sdk";
import { prisma } from "@calcom/prisma";
import { AttributeType, BillingPeriod, RedirectType, RoleType, SeatChangeType } from "@calcom/prisma/enums";
import { z } from "zod";
import { compositeId, safeDelete, splitCompositeId, toJsonValue } from "../helpers";

/** TeamBilling and OrganizationBilling are the same columns on two tables. */
const billingInput = z.object({
  teamId: z.number(),
  subscriptionId: z.string(),
  subscriptionItemId: z.string(),
  customerId: z.string(),
  status: z.string(),
  planName: z.string(),
  billingPeriod: z.nativeEnum(BillingPeriod).nullish(),
  pricePerSeat: z.number().nullish(),
  paidSeats: z.number().nullish(),
});

/**
 * Cal.diy has no team/organization tRPC router (it lives in the EE build), so
 * there is no reusable create function to call. This mirrors the insert the
 * repo's own e2e fixture performs in `createTeamAndAddUser`
 * (apps/web/playwright/fixtures/users.ts) minus the membership and feature-flag
 * side effects - those are separate factories here.
 */
export const Team = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    slug: z.string().nullish(),
    isOrganization: z.boolean().default(false),
    parentId: z.number().nullish(),
    bio: z.string().nullish(),
    isPrivate: z.boolean().optional(),
    hideBranding: z.boolean().optional(),
    timeZone: z.string().optional(),
    weekStart: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  }),
  create: async (data) => {
    const team = await prisma.team.create({
      data: {
        name: data.name,
        slug: data.slug ?? undefined,
        isOrganization: data.isOrganization,
        parentId: data.parentId ?? undefined,
        bio: data.bio ?? undefined,
        isPrivate: data.isPrivate,
        hideBranding: data.hideBranding,
        timeZone: data.timeZone,
        weekStart: data.weekStart,
        metadata: data.metadata ? toJsonValue(data.metadata) : undefined,
      },
    });
    return { id: team.id, slug: team.slug, isOrganization: team.isOrganization };
  },
  // The scoping root: deleting the team cascades memberships, profiles, team
  // event types, attributes, billing rows and anything else created under it -
  // including rows a test made mid-run that `up` never saw.
  teardown: async (record) => safeDelete(() => prisma.team.delete({ where: { id: Number(record.id) } })),
});

export const OrganizationSettings = defineFactory({
  inputSchema: z.object({
    organizationId: z.number(),
    orgAutoAcceptEmail: z.string(),
    isOrganizationConfigured: z.boolean().optional(),
    isOrganizationVerified: z.boolean().optional(),
    isAdminReviewed: z.boolean().optional(),
    isAdminAPIEnabled: z.boolean().optional(),
    orgAutoJoinOnSignup: z.boolean().optional(),
    allowSEOIndexing: z.boolean().optional(),
  }),
  create: async (data) => {
    const settings = await prisma.organizationSettings.create({ data });
    // Keyed on organizationId rather than the row id: DSyncData's FK points at
    // OrganizationSettings.organizationId, so a `_ref` to this record has to
    // resolve to the org id for the recipe to wire (and order) it correctly.
    return { id: settings.organizationId, settingsId: settings.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.organizationSettings.delete({ where: { organizationId: Number(record.id) } })),
});

export const ManagedOrganization = defineFactory({
  inputSchema: z.object({
    managerOrganizationId: z.number(),
    managedOrganizationId: z.number(),
  }),
  create: async (data) => {
    const managed = await prisma.managedOrganization.create({ data });
    return { id: managed.managedOrganizationId };
  },
  teardown: async (record) =>
    safeDelete(() =>
      prisma.managedOrganization.delete({ where: { managedOrganizationId: Number(record.id) } })
    ),
});

export const DSyncData = defineFactory({
  inputSchema: z.object({
    directoryId: z.string(),
    tenant: z.string(),
    // FK points at OrganizationSettings.organizationId, so the org needs its
    // settings row before this one.
    organizationId: z.number().nullish(),
  }),
  create: async (data) => {
    const dsync = await prisma.dSyncData.create({
      data: {
        directoryId: data.directoryId,
        tenant: data.tenant,
        organizationId: data.organizationId ?? undefined,
      },
    });
    return { id: dsync.id, directoryId: dsync.directoryId };
  },
  teardown: async (record) => safeDelete(() => prisma.dSyncData.delete({ where: { id: Number(record.id) } })),
});

export const DSyncTeamGroupMapping = defineFactory({
  inputSchema: z.object({
    organizationId: z.number(),
    teamId: z.number(),
    directoryId: z.string(),
    groupName: z.string(),
  }),
  create: async (data) => {
    const mapping = await prisma.dSyncTeamGroupMapping.create({ data });
    return { id: mapping.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.dSyncTeamGroupMapping.delete({ where: { id: Number(record.id) } })),
});

export const Role = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    teamId: z.number().nullish(),
    type: z.nativeEnum(RoleType).optional(),
    color: z.string().nullish(),
    description: z.string().nullish(),
  }),
  create: async (data) => {
    const role = await prisma.role.create({
      data: {
        name: data.name,
        teamId: data.teamId ?? undefined,
        type: data.type,
        color: data.color ?? undefined,
        description: data.description ?? undefined,
      },
    });
    return { id: role.id, name: role.name };
  },
  teardown: async (record) => safeDelete(() => prisma.role.delete({ where: { id: String(record.id) } })),
});

export const RolePermission = defineFactory({
  inputSchema: z.object({
    roleId: z.string(),
    resource: z.string(),
    action: z.string(),
  }),
  create: async (data) => {
    const permission = await prisma.rolePermission.create({ data });
    return { id: permission.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.rolePermission.delete({ where: { id: String(record.id) } })),
});

export const Attribute = defineFactory({
  inputSchema: z.object({
    teamId: z.number(),
    type: z.nativeEnum(AttributeType),
    name: z.string(),
    slug: z.string(),
    enabled: z.boolean().optional(),
    isLocked: z.boolean().optional(),
    isWeightsEnabled: z.boolean().optional(),
  }),
  create: async (data) => {
    const attribute = await prisma.attribute.create({ data });
    return { id: attribute.id, slug: attribute.slug };
  },
  teardown: async (record) => safeDelete(() => prisma.attribute.delete({ where: { id: String(record.id) } })),
});

export const AttributeOption = defineFactory({
  inputSchema: z.object({
    attributeId: z.string(),
    value: z.string(),
    slug: z.string(),
    isGroup: z.boolean().optional(),
    contains: z.array(z.string()).optional(),
  }),
  create: async (data) => {
    const option = await prisma.attributeOption.create({ data });
    return { id: option.id, value: option.value };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.attributeOption.delete({ where: { id: String(record.id) } })),
});

export const AttributeToUser = defineFactory({
  inputSchema: z.object({
    // Membership id, not user id - the assignment hangs off the org membership.
    memberId: z.number(),
    attributeOptionId: z.string(),
    weight: z.number().nullish(),
    createdById: z.number().nullish(),
  }),
  create: async (data) => {
    const assignment = await prisma.attributeToUser.create({
      data: {
        memberId: data.memberId,
        attributeOptionId: data.attributeOptionId,
        weight: data.weight ?? undefined,
        createdById: data.createdById ?? undefined,
      },
    });
    return { id: assignment.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.attributeToUser.delete({ where: { id: String(record.id) } })),
});

export const IntegrationAttributeSync = defineFactory({
  inputSchema: z.object({
    organizationId: z.number(),
    name: z.string(),
    integration: z.string(),
    enabled: z.boolean(),
    credentialId: z.number().nullish(),
  }),
  create: async (data) => {
    const sync = await prisma.integrationAttributeSync.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        integration: data.integration,
        enabled: data.enabled,
        credentialId: data.credentialId ?? undefined,
      },
    });
    return { id: sync.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.integrationAttributeSync.delete({ where: { id: String(record.id) } })),
});

export const AttributeSyncRule = defineFactory({
  inputSchema: z.object({
    integrationAttributeSyncId: z.string(),
    rule: z.record(z.string(), z.unknown()),
  }),
  create: async (data) => {
    const rule = await prisma.attributeSyncRule.create({
      data: {
        integrationAttributeSyncId: data.integrationAttributeSyncId,
        rule: toJsonValue(data.rule),
      },
    });
    return { id: rule.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.attributeSyncRule.delete({ where: { id: String(record.id) } })),
});

export const AttributeSyncFieldMapping = defineFactory({
  inputSchema: z.object({
    integrationFieldName: z.string(),
    attributeId: z.string(),
    enabled: z.boolean(),
    integrationAttributeSyncId: z.string(),
  }),
  create: async (data) => {
    const mapping = await prisma.attributeSyncFieldMapping.create({ data });
    return { id: mapping.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.attributeSyncFieldMapping.delete({ where: { id: String(record.id) } })),
});

export const TeamBilling = defineFactory({
  inputSchema: billingInput,
  create: async (data) => {
    const billing = await prisma.teamBilling.create({
      data: {
        ...data,
        billingPeriod: data.billingPeriod ?? undefined,
        pricePerSeat: data.pricePerSeat ?? undefined,
        paidSeats: data.paidSeats ?? undefined,
      },
    });
    return { id: billing.id, teamId: billing.teamId };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.teamBilling.delete({ where: { id: String(record.id) } })),
});

export const OrganizationBilling = defineFactory({
  inputSchema: billingInput,
  create: async (data) => {
    const billing = await prisma.organizationBilling.create({
      data: {
        ...data,
        billingPeriod: data.billingPeriod ?? undefined,
        pricePerSeat: data.pricePerSeat ?? undefined,
        paidSeats: data.paidSeats ?? undefined,
      },
    });
    return { id: billing.id, teamId: billing.teamId };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.organizationBilling.delete({ where: { id: String(record.id) } })),
});

export const SeatChangeLog = defineFactory({
  inputSchema: z.object({
    teamId: z.number(),
    changeType: z.nativeEnum(SeatChangeType),
    seatCount: z.number(),
    monthKey: z.string(),
    userId: z.number().nullish(),
    operationId: z.string().nullish(),
    teamBillingId: z.string().nullish(),
    organizationBillingId: z.string().nullish(),
  }),
  create: async (data) => {
    const log = await prisma.seatChangeLog.create({
      data: {
        teamId: data.teamId,
        changeType: data.changeType,
        seatCount: data.seatCount,
        monthKey: data.monthKey,
        userId: data.userId ?? undefined,
        operationId: data.operationId ?? undefined,
        teamBillingId: data.teamBillingId ?? undefined,
        organizationBillingId: data.organizationBillingId ?? undefined,
      },
    });
    return { id: log.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.seatChangeLog.delete({ where: { id: String(record.id) } })),
});

export const MonthlyProration = defineFactory({
  inputSchema: z.object({
    teamId: z.number(),
    monthKey: z.string(),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    seatsAtStart: z.number(),
    seatsAdded: z.number(),
    seatsRemoved: z.number(),
    netSeatIncrease: z.number(),
    seatsAtEnd: z.number(),
    subscriptionId: z.string(),
    subscriptionItemId: z.string(),
    customerId: z.string(),
    subscriptionStart: z.coerce.date(),
    subscriptionEnd: z.coerce.date(),
    remainingDays: z.number(),
    pricePerSeat: z.number(),
    proratedAmount: z.number(),
  }),
  create: async (data) => {
    const proration = await prisma.monthlyProration.create({ data });
    return { id: proration.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.monthlyProration.delete({ where: { id: String(record.id) } })),
});

export const PlatformBilling = defineFactory({
  inputSchema: z.object({
    // `id` is the team id - PlatformBilling shares its primary key with Team.
    id: z.number(),
    customerId: z.string(),
    subscriptionId: z.string().nullish(),
    priceId: z.string().nullish(),
    plan: z.string().optional(),
  }),
  create: async (data) => {
    const billing = await prisma.platformBilling.create({
      data: {
        id: data.id,
        customerId: data.customerId,
        subscriptionId: data.subscriptionId ?? undefined,
        priceId: data.priceId ?? undefined,
        plan: data.plan,
      },
    });
    return { id: billing.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.platformBilling.delete({ where: { id: Number(record.id) } })),
});

export const OrganizationOnboarding = defineFactory({
  inputSchema: z.object({
    createdById: z.number(),
    orgOwnerEmail: z.string(),
    billingPeriod: z.nativeEnum(BillingPeriod),
    pricePerSeat: z.number(),
    seats: z.number(),
    name: z.string(),
    slug: z.string(),
    organizationId: z.number().nullish(),
    isComplete: z.boolean().optional(),
  }),
  create: async (data) => {
    const onboarding = await prisma.organizationOnboarding.create({
      data: {
        createdById: data.createdById,
        orgOwnerEmail: data.orgOwnerEmail,
        billingPeriod: data.billingPeriod,
        pricePerSeat: data.pricePerSeat,
        seats: data.seats,
        name: data.name,
        slug: data.slug,
        organizationId: data.organizationId ?? undefined,
        isComplete: data.isComplete,
      },
    });
    return { id: onboarding.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.organizationOnboarding.delete({ where: { id: String(record.id) } })),
});

export const InternalNotePreset = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    teamId: z.number(),
    cancellationReason: z.string().nullish(),
  }),
  create: async (data) => {
    const preset = await prisma.internalNotePreset.create({
      data: {
        name: data.name,
        teamId: data.teamId,
        cancellationReason: data.cancellationReason ?? undefined,
      },
    });
    return { id: preset.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.internalNotePreset.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors the upsert in `createAProfileForAnExistingUser` (org username redirects). */
export const TempOrgRedirect = defineFactory({
  inputSchema: z.object({
    from: z.string(),
    fromOrgId: z.number(),
    type: z.nativeEnum(RedirectType),
    toUrl: z.string(),
    enabled: z.boolean().optional(),
  }),
  create: async (data) => {
    const redirect = await prisma.tempOrgRedirect.upsert({
      where: {
        from_type_fromOrgId: { from: data.from, type: data.type, fromOrgId: data.fromOrgId },
      },
      update: { toUrl: data.toUrl, enabled: data.enabled },
      create: {
        from: data.from,
        fromOrgId: data.fromOrgId,
        type: data.type,
        toUrl: data.toUrl,
        enabled: data.enabled,
      },
    });
    return { id: redirect.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.tempOrgRedirect.delete({ where: { id: Number(record.id) } })),
});

/**
 * `uploadLogo`/`uploadAvatar` in packages/lib/server/avatar.ts run the base64
 * payload through sharp before writing. A seeded placeholder string is not a
 * decodable image, so this factory writes the row the same upsert produces and
 * skips the conversion.
 */
export const Avatar = defineFactory({
  inputSchema: z.object({
    objectKey: z.string(),
    data: z.string(),
    teamId: z.number().optional(),
    userId: z.number().optional(),
    isBanner: z.boolean().optional(),
  }),
  create: async (data) => {
    const teamId = data.teamId ?? 0;
    const userId = data.userId ?? 0;
    const isBanner = data.isBanner ?? false;
    await prisma.avatar.upsert({
      where: { teamId_userId_isBanner: { teamId, userId, isBanner } },
      update: { data: data.data },
      create: { teamId, userId, isBanner, data: data.data, objectKey: data.objectKey },
    });
    return { id: compositeId(teamId, userId, String(isBanner)) };
  },
  teardown: async (record) => {
    const [teamId, userId, isBanner] = splitCompositeId(record.id);
    await safeDelete(() =>
      prisma.avatar.delete({
        where: {
          teamId_userId_isBanner: {
            teamId: Number(teamId),
            userId: Number(userId),
            isBanner: isBanner === "true",
          },
        },
      })
    );
  },
});
