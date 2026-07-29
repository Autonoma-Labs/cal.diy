import { defineFactory } from "@autonoma-ai/sdk";
import { AssignmentReasonRepository } from "@calcom/features/assignment-reason/repositories/AssignmentReasonRepository";
import { PrismaAuditActorRepository } from "@calcom/features/booking-audit/lib/repository/PrismaAuditActorRepository";
import { PrismaBookingAuditRepository } from "@calcom/features/booking-audit/lib/repository/PrismaBookingAuditRepository";
import { PrismaBookingReportRepository } from "@calcom/features/bookingReport/repositories/PrismaBookingReportRepository";
import { PrismaBookingPaymentRepository } from "@calcom/features/bookings/repositories/PrismaBookingPaymentRepository";
import { WrongAssignmentReportRepository } from "@calcom/features/bookings/repositories/WrongAssignmentReportRepository";
import { VideoCallGuestRepository } from "@calcom/features/video-call-guest/repositories/VideoCallGuestRepository";
import { PrismaWatchlistAuditRepository } from "@calcom/features/watchlist/lib/repository/PrismaWatchlistAuditRepository";
import { prisma } from "@calcom/prisma";
import {
  AssignmentReasonEnum,
  AuditActorType,
  BookingAuditAction,
  BookingAuditSource,
  BookingAuditType,
  BookingReportReason,
  BookingStatus,
  CreationSource,
  ReminderType,
  WatchlistAction,
  WatchlistSource,
  WatchlistType,
} from "@calcom/prisma/enums";
import { z } from "zod";
import { safeDelete, toJsonValue } from "../helpers";

/**
 * `createBooking()` in handleNewBooking is not callable standalone - it wants a
 * built CalendarEvent, the parsed request body and an eventType decorated with
 * payment/organizer data, and it fans out to payment-credential lookups. This
 * factory replicates the insert `saveBooking()` performs (booking + nested
 * attendees) and drops the request-scoped and external-service side effects.
 */
export const Booking = defineFactory({
  inputSchema: z.object({
    uid: z.string(),
    title: z.string(),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    userId: z.number().nullish(),
    eventTypeId: z.number().nullish(),
    status: z.nativeEnum(BookingStatus).optional(),
    description: z.string().nullish(),
    location: z.string().nullish(),
    userPrimaryEmail: z.string().nullish(),
    paid: z.boolean().optional(),
    rescheduled: z.boolean().nullish(),
    fromReschedule: z.string().nullish(),
    recurringEventId: z.string().nullish(),
    cancellationReason: z.string().nullish(),
    rejectionReason: z.string().nullish(),
    smsReminderNumber: z.string().nullish(),
    iCalUID: z.string().optional(),
    iCalSequence: z.number().optional(),
    rating: z.number().nullish(),
    ratingFeedback: z.string().nullish(),
    noShowHost: z.boolean().nullish(),
    responses: z.record(z.string(), z.unknown()).nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
    creationSource: z.nativeEnum(CreationSource).optional(),
  }),
  create: async (data) => {
    const booking = await prisma.booking.create({
      data: {
        uid: data.uid,
        title: data.title,
        startTime: data.startTime,
        endTime: data.endTime,
        userId: data.userId ?? undefined,
        eventTypeId: data.eventTypeId ?? undefined,
        status: data.status,
        description: data.description ?? undefined,
        location: data.location ?? undefined,
        userPrimaryEmail: data.userPrimaryEmail ?? undefined,
        paid: data.paid,
        rescheduled: data.rescheduled ?? undefined,
        fromReschedule: data.fromReschedule ?? undefined,
        recurringEventId: data.recurringEventId ?? undefined,
        cancellationReason: data.cancellationReason ?? undefined,
        rejectionReason: data.rejectionReason ?? undefined,
        smsReminderNumber: data.smsReminderNumber ?? undefined,
        // The booking pipeline always stamps an iCalUID; keeping it consistent
        // means calendar-facing assertions see the same shape as production.
        iCalUID: data.iCalUID ?? `${data.uid}@cal.com`,
        iCalSequence: data.iCalSequence,
        rating: data.rating ?? undefined,
        ratingFeedback: data.ratingFeedback ?? undefined,
        noShowHost: data.noShowHost ?? undefined,
        responses: data.responses ? toJsonValue(data.responses) : undefined,
        metadata: data.metadata ? toJsonValue(data.metadata) : undefined,
        creationSource: data.creationSource ?? CreationSource.WEBAPP,
      },
    });
    return { id: booking.id, uid: booking.uid };
  },
  // Cascades attendees, references, seats, payments, tracking and notes.
  teardown: async (record) => safeDelete(() => prisma.booking.delete({ where: { id: Number(record.id) } })),
});

/** Attendees are written nested inside the booking insert; same shape here. */
export const Attendee = defineFactory({
  inputSchema: z.object({
    bookingId: z.number().nullish(),
    email: z.string(),
    name: z.string(),
    timeZone: z.string(),
    locale: z.string().nullish(),
    phoneNumber: z.string().nullish(),
    noShow: z.boolean().nullish(),
  }),
  create: async (data) => {
    const attendee = await prisma.attendee.create({
      data: {
        bookingId: data.bookingId ?? undefined,
        email: data.email,
        name: data.name,
        timeZone: data.timeZone,
        locale: data.locale ?? undefined,
        phoneNumber: data.phoneNumber ?? undefined,
        noShow: data.noShow ?? undefined,
      },
    });
    return { id: attendee.id, email: attendee.email };
  },
  teardown: async (record) => safeDelete(() => prisma.attendee.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors the seat insert in `RegularBookingService`. */
export const BookingSeat = defineFactory({
  inputSchema: z.object({
    referenceUid: z.string(),
    bookingId: z.number(),
    attendeeId: z.number(),
    data: z.record(z.string(), z.unknown()).nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  }),
  create: async (input) => {
    const seat = await prisma.bookingSeat.create({
      data: {
        referenceUid: input.referenceUid,
        bookingId: input.bookingId,
        attendeeId: input.attendeeId,
        data: input.data ? toJsonValue(input.data) : undefined,
        metadata: input.metadata ? toJsonValue(input.metadata) : undefined,
      },
    });
    return { id: seat.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.bookingSeat.delete({ where: { id: Number(record.id) } })),
});

/** Same row `BookingReferenceRepository.replaceBookingReferences` writes. */
export const BookingReference = defineFactory({
  inputSchema: z.object({
    bookingId: z.number().nullish(),
    type: z.string(),
    uid: z.string(),
    meetingId: z.string().nullish(),
    meetingPassword: z.string().nullish(),
    meetingUrl: z.string().nullish(),
    externalCalendarId: z.string().nullish(),
    credentialId: z.number().nullish(),
  }),
  create: async (data) => {
    const reference = await prisma.bookingReference.create({
      data: {
        bookingId: data.bookingId ?? undefined,
        type: data.type,
        uid: data.uid,
        meetingId: data.meetingId ?? undefined,
        meetingPassword: data.meetingPassword ?? undefined,
        meetingUrl: data.meetingUrl ?? undefined,
        externalCalendarId: data.externalCalendarId ?? undefined,
        credentialId: data.credentialId ?? undefined,
      },
    });
    return { id: reference.id, uid: reference.uid };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.bookingReference.delete({ where: { id: Number(record.id) } })),
});

export const VideoCallGuest = defineFactory({
  inputSchema: z.object({
    bookingUid: z.string(),
    email: z.string(),
    name: z.string(),
  }),
  create: async (data) => {
    const repository = new VideoCallGuestRepository(prisma);
    const guest = await repository.upsertVideoCallGuest(data);
    return { id: guest.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.videoCallGuest.delete({ where: { id: String(record.id) } })),
});

/** Written nested inside the booking insert (`tracking: { create: ... }`). */
export const Tracking = defineFactory({
  inputSchema: z.object({
    bookingId: z.number(),
    utm_source: z.string().nullish(),
    utm_medium: z.string().nullish(),
    utm_campaign: z.string().nullish(),
    utm_term: z.string().nullish(),
    utm_content: z.string().nullish(),
  }),
  create: async (data) => {
    const tracking = await prisma.tracking.create({
      data: {
        bookingId: data.bookingId,
        utm_source: data.utm_source ?? undefined,
        utm_medium: data.utm_medium ?? undefined,
        utm_campaign: data.utm_campaign ?? undefined,
        utm_term: data.utm_term ?? undefined,
        utm_content: data.utm_content ?? undefined,
      },
    });
    return { id: tracking.id };
  },
  teardown: async (record) => safeDelete(() => prisma.tracking.delete({ where: { id: Number(record.id) } })),
});

export const Payment = defineFactory({
  inputSchema: z.object({
    uid: z.string(),
    bookingId: z.number(),
    appId: z.string(),
    amount: z.number(),
    fee: z.number().optional(),
    currency: z.string(),
    success: z.boolean(),
    refunded: z.boolean().optional(),
    externalId: z.string(),
    data: z.record(z.string(), z.unknown()).nullish(),
  }),
  create: async (data) => {
    const repository = new PrismaBookingPaymentRepository(prisma);
    const payment = await repository.createPaymentRecord({
      uid: data.uid,
      app: { connect: { slug: data.appId } },
      booking: { connect: { id: data.bookingId } },
      amount: data.amount,
      fee: data.fee ?? 0,
      currency: data.currency,
      success: data.success,
      refunded: data.refunded ?? false,
      externalId: data.externalId,
      data: toJsonValue(data.data),
    });
    return { id: payment.id, uid: payment.uid };
  },
  teardown: async (record) => safeDelete(() => prisma.payment.delete({ where: { id: Number(record.id) } })),
});

export const AssignmentReason = defineFactory({
  inputSchema: z.object({
    bookingId: z.number(),
    reasonEnum: z.nativeEnum(AssignmentReasonEnum),
    reasonString: z.string(),
  }),
  create: async (data) => {
    const repository = new AssignmentReasonRepository(prisma);
    const reason = await repository.createAssignmentReason(data);
    return { id: reason.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.assignmentReason.delete({ where: { id: Number(record.id) } })),
});

/**
 * A read-model table kept in sync by the denormalization job; there is no
 * application write path, so the row is inserted with the same columns the job
 * projects from Booking.
 */
export const BookingDenormalized = defineFactory({
  inputSchema: z.object({
    id: z.number(),
    uid: z.string(),
    title: z.string(),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    createdAt: z.coerce.date(),
    paid: z.boolean(),
    status: z.nativeEnum(BookingStatus),
    isTeamBooking: z.boolean().optional(),
    eventTypeId: z.number().nullish(),
    userId: z.number().nullish(),
    teamId: z.number().nullish(),
    description: z.string().nullish(),
    location: z.string().nullish(),
    eventLength: z.number().nullish(),
    userEmail: z.string().nullish(),
    userName: z.string().nullish(),
    userUsername: z.string().nullish(),
  }),
  create: async (data) => {
    const denormalized = await prisma.bookingDenormalized.create({
      data: {
        id: data.id,
        uid: data.uid,
        title: data.title,
        startTime: data.startTime,
        endTime: data.endTime,
        createdAt: data.createdAt,
        paid: data.paid,
        status: data.status,
        isTeamBooking: data.isTeamBooking ?? false,
        eventTypeId: data.eventTypeId ?? undefined,
        userId: data.userId ?? undefined,
        teamId: data.teamId ?? undefined,
        description: data.description ?? undefined,
        location: data.location ?? undefined,
        eventLength: data.eventLength ?? undefined,
        userEmail: data.userEmail ?? undefined,
        userName: data.userName ?? undefined,
        userUsername: data.userUsername ?? undefined,
      },
    });
    return { id: denormalized.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.bookingDenormalized.delete({ where: { id: Number(record.id) } })),
});

/** Consumed by `loggedInViewer/connectAndJoin.handler` for instant meetings. */
export const InstantMeetingToken = defineFactory({
  inputSchema: z.object({
    token: z.string(),
    expires: z.coerce.date(),
    teamId: z.number(),
    bookingId: z.number().nullish(),
  }),
  create: async (data) => {
    const token = await prisma.instantMeetingToken.create({
      data: {
        token: data.token,
        expires: data.expires,
        teamId: data.teamId,
        bookingId: data.bookingId ?? undefined,
      },
    });
    return { id: token.id, token: token.token };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.instantMeetingToken.delete({ where: { id: Number(record.id) } })),
});

/** Mirrors the insert in `app/api/cron/bookingReminder`. */
export const ReminderMail = defineFactory({
  inputSchema: z.object({
    referenceId: z.number(),
    reminderType: z.nativeEnum(ReminderType),
    elapsedMinutes: z.number(),
  }),
  create: async (data) => {
    const reminder = await prisma.reminderMail.create({ data });
    return { id: reminder.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.reminderMail.delete({ where: { id: Number(record.id) } })),
});

/**
 * `handleInternalNote` is the app's write path but it also enforces host/owner
 * permissions against a fully-loaded booking - handler concerns that don't
 * belong in a factory. The insert below is the one it performs.
 */
export const BookingInternalNote = defineFactory({
  inputSchema: z.object({
    bookingId: z.number(),
    createdById: z.number(),
    text: z.string().nullish(),
    notePresetId: z.number().nullish(),
  }),
  create: async (data) => {
    const note = await prisma.bookingInternalNote.create({
      data: {
        bookingId: data.bookingId,
        createdById: data.createdById,
        text: data.text ?? undefined,
        notePresetId: data.notePresetId ?? undefined,
      },
    });
    return { id: note.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.bookingInternalNote.delete({ where: { id: Number(record.id) } })),
});

export const AuditActor = defineFactory({
  inputSchema: z.object({
    type: z.nativeEnum(AuditActorType),
    userUuid: z.string().nullish(),
    attendeeId: z.number().nullish(),
    credentialId: z.number().nullish(),
    email: z.string().nullish(),
    name: z.string().nullish(),
    phone: z.string().nullish(),
  }),
  create: async (data) => {
    const repository = new PrismaAuditActorRepository({ prismaClient: prisma });
    // Each actor type has its own idempotent creator on the repository.
    if (data.type === AuditActorType.USER && data.userUuid) {
      const actor = await repository.createIfNotExistsUserActor({ userUuid: data.userUuid });
      return { id: actor.id };
    }
    if (data.type === AuditActorType.ATTENDEE && data.attendeeId) {
      const actor = await repository.createIfNotExistsAttendeeActor({ attendeeId: data.attendeeId });
      return { id: actor.id };
    }
    if (data.type === AuditActorType.APP) {
      const actor = await repository.createIfNotExistsAppActor(
        data.credentialId
          ? { credentialId: data.credentialId }
          : { email: data.email ?? "", name: data.name ?? "" }
      );
      return { id: actor.id };
    }
    if (data.type === AuditActorType.GUEST) {
      const actor = await repository.createIfNotExistsGuestActor({
        email: data.email ?? null,
        name: data.name ?? null,
        phone: data.phone ?? null,
      });
      return { id: actor.id };
    }
    // The repository exposes no SYSTEM creator (system actors are minted inline
    // by the audit consumer), so the row is written directly.
    const actor = await prisma.auditActor.create({
      data: {
        type: data.type,
        email: data.email ?? undefined,
        name: data.name ?? undefined,
        phone: data.phone ?? undefined,
      },
    });
    return { id: actor.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.auditActor.delete({ where: { id: String(record.id) } })),
});

export const BookingAudit = defineFactory({
  inputSchema: z.object({
    bookingUid: z.string(),
    actorId: z.string(),
    type: z.nativeEnum(BookingAuditType),
    action: z.nativeEnum(BookingAuditAction),
    source: z.nativeEnum(BookingAuditSource),
    timestamp: z.coerce.date(),
    operationId: z.string(),
    data: z.record(z.string(), z.unknown()).nullish(),
    context: z.record(z.string(), z.unknown()).nullish(),
  }),
  create: async (data) => {
    const repository = new PrismaBookingAuditRepository({ prismaClient: prisma });
    const audit = await repository.create({
      bookingUid: data.bookingUid,
      actorId: data.actorId,
      type: data.type,
      action: data.action,
      source: data.source,
      timestamp: data.timestamp,
      operationId: data.operationId,
      data: data.data ? toJsonValue(data.data) : undefined,
      context: data.context ? toJsonValue(data.context) : undefined,
    });
    return { id: audit.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.bookingAudit.delete({ where: { id: String(record.id) } })),
});

export const BookingReport = defineFactory({
  inputSchema: z.object({
    bookingUid: z.string(),
    bookerEmail: z.string(),
    reason: z.nativeEnum(BookingReportReason),
    reportedById: z.number().nullish(),
    organizationId: z.number().nullish(),
    description: z.string().nullish(),
    cancelled: z.boolean().optional(),
  }),
  create: async (data) => {
    const repository = new PrismaBookingReportRepository(prisma);
    const report = await repository.createReport({
      bookingUid: data.bookingUid,
      bookerEmail: data.bookerEmail,
      reason: data.reason,
      reportedById: data.reportedById ?? undefined,
      organizationId: data.organizationId ?? undefined,
      description: data.description ?? undefined,
      cancelled: data.cancelled ?? false,
    });
    return { id: report.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.bookingReport.delete({ where: { id: String(record.id) } })),
});

export const WrongAssignmentReport = defineFactory({
  inputSchema: z.object({
    bookingUid: z.string(),
    reportedById: z.number(),
    additionalNotes: z.string(),
    correctAssignee: z.string().nullish(),
    teamId: z.number().nullish(),
  }),
  create: async (data) => {
    const repository = new WrongAssignmentReportRepository(prisma);
    const report = await repository.createReport({
      bookingUid: data.bookingUid,
      reportedById: data.reportedById,
      additionalNotes: data.additionalNotes,
      correctAssignee: data.correctAssignee ?? null,
      teamId: data.teamId ?? null,
    });
    return { id: report.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.wrongAssignmentReport.delete({ where: { id: String(record.id) } })),
});

/**
 * `WatchlistRepository` only writes inside transactions that also emit an audit
 * row; this factory writes the watchlist entry alone so the audit row stays its
 * own recipe entity.
 */
export const Watchlist = defineFactory({
  inputSchema: z.object({
    type: z.nativeEnum(WatchlistType),
    value: z.string(),
    action: z.nativeEnum(WatchlistAction).optional(),
    source: z.nativeEnum(WatchlistSource).optional(),
    description: z.string().nullish(),
    isGlobal: z.boolean().optional(),
    organizationId: z.number().nullish(),
  }),
  create: async (data) => {
    const entry = await prisma.watchlist.create({
      data: {
        type: data.type,
        value: data.value,
        action: data.action,
        source: data.source,
        description: data.description ?? undefined,
        isGlobal: data.isGlobal,
        organizationId: data.organizationId ?? undefined,
      },
    });
    return { id: entry.id };
  },
  teardown: async (record) => safeDelete(() => prisma.watchlist.delete({ where: { id: String(record.id) } })),
});

export const WatchlistAudit = defineFactory({
  inputSchema: z.object({
    type: z.nativeEnum(WatchlistType),
    value: z.string(),
    action: z.nativeEnum(WatchlistAction).optional(),
    description: z.string().nullish(),
    changedByUserId: z.number().nullish(),
    watchlistId: z.string().nullish(),
  }),
  create: async (data) => {
    const repository = new PrismaWatchlistAuditRepository(prisma);
    const audit = await repository.create({
      type: data.type,
      value: data.value,
      action: data.action ?? WatchlistAction.REPORT,
      description: data.description ?? null,
      changedByUserId: data.changedByUserId ?? null,
      watchlistId: data.watchlistId ?? null,
    });
    return { id: audit.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.watchlistAudit.delete({ where: { id: String(record.id) } })),
});

export const WatchlistEventAudit = defineFactory({
  inputSchema: z.object({
    watchlistId: z.string(),
    eventTypeId: z.number(),
    actionTaken: z.nativeEnum(WatchlistAction),
  }),
  create: async (data) => {
    const audit = await prisma.watchlistEventAudit.create({ data });
    return { id: audit.id };
  },
  teardown: async (record) =>
    safeDelete(() => prisma.watchlistEventAudit.delete({ where: { id: String(record.id) } })),
});
