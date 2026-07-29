import { defineFactory } from "@autonoma-ai/sdk";
import { CalVideoSettingsRepository } from "@calcom/features/calVideoSettings/repositories/CalVideoSettingsRepository";
import { EventTypeTranslationRepository } from "@calcom/features/eventTypeTranslation/repositories/EventTypeTranslationRepository";
import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { HashedLinkRepository } from "@calcom/features/hashedLink/lib/repository/HashedLinkRepository";
import { prisma } from "@calcom/prisma";
import { EventTypeAutoTranslatedField, EventTypeCustomInputType, SchedulingType } from "@calcom/prisma/enums";
import { z } from "zod";
import { compositeId, safeDelete, splitCompositeId, toJsonValue } from "../helpers";

export const EventType = defineFactory({
  inputSchema: z.object({
    title: z.string(),
    slug: z.string(),
    length: z.number(),
    userId: z.number().nullish(),
    teamId: z.number().nullish(),
    profileId: z.number().nullish(),
    parentId: z.number().nullish(),
    scheduleId: z.number().nullish(),
    description: z.string().nullish(),
    hidden: z.boolean().optional(),
    position: z.number().optional(),
    price: z.number().optional(),
    currency: z.string().optional(),
    schedulingType: z.nativeEnum(SchedulingType).nullish(),
    requiresConfirmation: z.boolean().optional(),
    disableGuests: z.boolean().optional(),
    seatsPerTimeSlot: z.number().nullish(),
    minimumBookingNotice: z.number().optional(),
    beforeEventBuffer: z.number().optional(),
    afterEventBuffer: z.number().optional(),
    slotInterval: z.number().nullish(),
    eventName: z.string().nullish(),
    successRedirectUrl: z.string().nullish(),
    assignAllTeamMembers: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
    recurringEvent: z.record(z.string(), z.unknown()).nullish(),
    bookingLimits: z.record(z.string(), z.unknown()).nullish(),
    durationLimits: z.record(z.string(), z.unknown()).nullish(),
  }),
  create: async (data) => {
    const eventTypeRepository = new EventTypeRepository(prisma);
    const { userId, teamId, profileId, parentId, scheduleId, metadata, ...rest } = data;
    const eventType = await eventTypeRepository.create({
      ...rest,
      description: data.description ?? undefined,
      schedulingType: data.schedulingType ?? undefined,
      seatsPerTimeSlot: data.seatsPerTimeSlot ?? undefined,
      slotInterval: data.slotInterval ?? undefined,
      eventName: data.eventName ?? undefined,
      successRedirectUrl: data.successRedirectUrl ?? undefined,
      userId: userId ?? null,
      teamId: teamId ?? null,
      profileId: profileId ?? null,
      parentId: parentId ?? null,
      scheduleId: scheduleId ?? null,
      metadata: metadata ? toJsonValue(metadata) : undefined,
      recurringEvent: data.recurringEvent ? toJsonValue(data.recurringEvent) : undefined,
      bookingLimits: data.bookingLimits ? toJsonValue(data.bookingLimits) : undefined,
      durationLimits: data.durationLimits ? toJsonValue(data.durationLimits) : undefined,
      // The repository maps userId onto `owner` only. Personal event types also
      // need the many-to-many `users` link to be listed and bookable, which is
      // what the app's own event-type creation does.
      ...(userId ? { users: { connect: { id: userId } } } : {}),
    });
    return { id: eventType.id, slug: eventType.slug, title: eventType.title };
  },
  teardown: async (record) => safeDelete(() => prisma.eventType.delete({ where: { id: Number(record.id) } })),
});

/**
 * Hosts are written with a bare insert wherever the app assigns team members to
 * a round-robin/collective event (see the e2e fixture and
 * `eventTypes/heavy/update.handler`). Primary key is (userId, eventTypeId).
 */
export const Host = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    eventTypeId: z.number(),
    isFixed: z.boolean().optional(),
    priority: z.number().nullish(),
    weight: z.number().nullish(),
    scheduleId: z.number().nullish(),
    groupId: z.string().nullish(),
    memberId: z.number().nullish(),
  }),
  create: async (data) => {
    const host = await prisma.host.create({
      data: {
        userId: data.userId,
        eventTypeId: data.eventTypeId,
        isFixed: data.isFixed,
        priority: data.priority ?? undefined,
        weight: data.weight ?? undefined,
        scheduleId: data.scheduleId ?? undefined,
        groupId: data.groupId ?? undefined,
        memberId: data.memberId ?? undefined,
      },
    });
    return { id: compositeId(host.userId, host.eventTypeId) };
  },
  teardown: async (record) => {
    const [userId, eventTypeId] = splitCompositeId(record.id);
    await safeDelete(() =>
      prisma.host.delete({
        where: { userId_eventTypeId: { userId: Number(userId), eventTypeId: Number(eventTypeId) } },
      })
    );
  },
});

/** Mirrors the createMany in `viewer/eventTypes/heavy/update.handler`. */
export const HostGroup = defineFactory({
  inputSchema: z.object({
    name: z.string(),
    eventTypeId: z.number().nullish(),
  }),
  create: async (data) => {
    const group = await prisma.hostGroup.create({
      data: { name: data.name, eventTypeId: data.eventTypeId ?? undefined },
    });
    return { id: group.id, name: group.name };
  },
  teardown: async (record) => safeDelete(() => prisma.hostGroup.delete({ where: { id: String(record.id) } })),
});

/** Same shape `HostLocationRepository.upsertMany` writes; keyed by the host. */
export const HostLocation = defineFactory({
  inputSchema: z.object({
    userId: z.number(),
    eventTypeId: z.number(),
    type: z.string(),
    link: z.string().nullish(),
    address: z.string().nullish(),
    phoneNumber: z.string().nullish(),
    credentialId: z.number().nullish(),
  }),
  create: async (data) => {
    const location = await prisma.hostLocation.upsert({
      where: { userId_eventTypeId: { userId: data.userId, eventTypeId: data.eventTypeId } },
      update: {
        type: data.type,
        link: data.link ?? undefined,
        address: data.address ?? undefined,
        phoneNumber: data.phoneNumber ?? undefined,
        credentialId: data.credentialId ?? undefined,
      },
      create: {
        userId: data.userId,
        eventTypeId: data.eventTypeId,
        type: data.type,
        link: data.link ?? undefined,
        address: data.address ?? undefined,
        phoneNumber: data.phoneNumber ?? undefined,
        credentialId: data.credentialId ?? undefined,
      },
    });
    return { id: location.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.hostLocation.delete({ where: { id: String(record.id) } })),
});

export const CalVideoSettings = defineFactory({
  inputSchema: z.object({
    eventTypeId: z.number(),
    disableRecordingForOrganizer: z.boolean().nullish(),
    disableRecordingForGuests: z.boolean().nullish(),
    enableAutomaticTranscription: z.boolean().nullish(),
    enableAutomaticRecordingForOrganizer: z.boolean().nullish(),
    disableTranscriptionForGuests: z.boolean().nullish(),
    disableTranscriptionForOrganizer: z.boolean().nullish(),
    requireEmailForGuests: z.boolean().nullish(),
    redirectUrlOnExit: z.string().nullish(),
  }),
  create: async ({ eventTypeId, ...calVideoSettings }) => {
    const settings = await CalVideoSettingsRepository.createCalVideoSettings({
      eventTypeId,
      calVideoSettings,
    });
    return { id: settings.eventTypeId };
  },
  teardown: async (record) =>
    safeDelete(() => CalVideoSettingsRepository.deleteCalVideoSettings(Number(record.id))),
});

/** Mirrors the createMany in `viewer/eventTypes/heavy/duplicate.handler`. */
export const EventTypeCustomInput = defineFactory({
  inputSchema: z.object({
    eventTypeId: z.number(),
    label: z.string(),
    type: z.nativeEnum(EventTypeCustomInputType),
    required: z.boolean(),
    placeholder: z.string().optional(),
    options: z.array(z.unknown()).nullish(),
  }),
  create: async (data) => {
    const customInput = await prisma.eventTypeCustomInput.create({
      data: {
        eventTypeId: data.eventTypeId,
        label: data.label,
        type: data.type,
        required: data.required,
        placeholder: data.placeholder,
        options: data.options ? toJsonValue(data.options) : undefined,
      },
    });
    return { id: customInput.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.eventTypeCustomInput.delete({ where: { id: Number(record.id) } })),
});

export const EventTypeTranslation = defineFactory({
  inputSchema: z.object({
    eventTypeId: z.number(),
    field: z.nativeEnum(EventTypeAutoTranslatedField),
    sourceLocale: z.string(),
    targetLocale: z.string(),
    translatedText: z.string(),
    /** Author of the translation - stored as `createdBy`. */
    userId: z.number(),
  }),
  create: async (data) => {
    const repository = new EventTypeTranslationRepository(prisma);
    const translation = {
      eventTypeId: data.eventTypeId,
      sourceLocale: data.sourceLocale,
      targetLocale: data.targetLocale,
      translatedText: data.translatedText,
      userId: data.userId,
    };
    const [created] =
      data.field === EventTypeAutoTranslatedField.TITLE
        ? await repository.upsertManyTitleTranslations([translation])
        : await repository.upsertManyDescriptionTranslations([translation]);
    return { id: created.uid };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.eventTypeTranslation.delete({ where: { uid: String(record.id) } })),
});

export const HashedLink = defineFactory({
  inputSchema: z.object({
    eventTypeId: z.number(),
    link: z.string(),
    expiresAt: z.coerce.date().nullish(),
    maxUsageCount: z.number().nullish(),
  }),
  create: async (data) => {
    const repository = new HashedLinkRepository(prisma);
    const hashedLink = await repository.createLink(data.eventTypeId, {
      link: data.link,
      expiresAt: data.expiresAt ?? null,
      maxUsageCount: data.maxUsageCount ?? null,
    });
    return { id: hashedLink.id, link: hashedLink.link };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.hashedLink.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors the upsert in `viewer/slots/reserveSlot.handler`. */
export const SelectedSlots = defineFactory({
  inputSchema: z.object({
    eventTypeId: z.number(),
    userId: z.number(),
    slotUtcStartDate: z.coerce.date(),
    slotUtcEndDate: z.coerce.date(),
    uid: z.string(),
    releaseAt: z.coerce.date(),
    isSeat: z.boolean().optional(),
  }),
  create: async (data) => {
    const slot = await prisma.selectedSlots.upsert({
      where: {
        selectedSlotUnique: {
          userId: data.userId,
          slotUtcStartDate: data.slotUtcStartDate,
          slotUtcEndDate: data.slotUtcEndDate,
          uid: data.uid,
        },
      },
      update: { releaseAt: data.releaseAt },
      create: {
        eventTypeId: data.eventTypeId,
        userId: data.userId,
        slotUtcStartDate: data.slotUtcStartDate,
        slotUtcEndDate: data.slotUtcEndDate,
        uid: data.uid,
        releaseAt: data.releaseAt,
        isSeat: data.isSeat,
      },
    });
    return { id: slot.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.selectedSlots.delete({ where: { id: Number(record.id) } })),
});
