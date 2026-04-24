/**
 * Scenario-safe Booking creator.
 *
 * Writes a Booking row (plus nested Attendees) with no production
 * side-effects — no EventManager dispatch, no email/SMS/webhook scheduling,
 * no payment creation, no calendar integration. Used exclusively by the
 * Autonoma Environment Factory endpoint (apps/web/app/api/autonoma/route.ts)
 * to seed booking-heavy test scenarios.
 *
 * The production path `createBooking` in handleNewBooking/createBooking.ts
 * requires a fully-built `CalendarEvent` / `LoadedUsers` tuple assembled by
 * the booking HTTP pipeline. That shape is not constructible from a bare
 * scenario tree, so rather than contort scenarios into that pipeline we
 * expose this narrower writer.
 *
 * Why it lives here, not in `BookingRepository`:
 *   Repositories in this codebase host data-access methods. Scenario seeding
 *   is a bounded, app-level concern (test-only) that mirrors the shape of
 *   `BookingRepository.createBookingForManagedEventReassignment` but omits
 *   its manage-event-specific invariants. Keeping it beside the production
 *   `create-booking.ts` keeps the scenario surface area obvious to a
 *   reviewer.
 */
import short from "short-uuid";

import { ErrorWithCode } from "@calcom/lib/errors";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { prisma } from "@calcom/prisma";
import type { Booking, Prisma } from "@calcom/prisma/client";
import { BookingStatus } from "@calcom/prisma/enums";

export type CreateBookingForScenarioAttendee = {
  name: string;
  email: string;
  timeZone: string;
  locale?: string | null;
  phoneNumber?: string | null;
};

export type CreateBookingForScenarioInput = {
  userId: number;
  eventTypeId?: number | null;
  title: string;
  startTime: Date;
  endTime: Date;
  status?: BookingStatus;
  description?: string | null;
  location?: string | null;
  uid?: string;
  smsReminderNumber?: string | null;
  responses?: Prisma.InputJsonValue | null;
  metadata?: Prisma.InputJsonValue | null;
  attendees?: CreateBookingForScenarioAttendee[];
};

export type CreateBookingForScenarioResult = Pick<
  Booking,
  "id" | "uid" | "title" | "startTime" | "endTime" | "status" | "userId" | "eventTypeId"
>;

export async function createBookingForScenario(
  input: CreateBookingForScenarioInput,
): Promise<CreateBookingForScenarioResult> {
  if (!Number.isFinite(input.userId) || input.userId <= 0) {
    throw new ErrorWithCode(ErrorCode.RequestBodyInvalid, "createBookingForScenario: userId is required");
  }
  // eventTypeId is optional: the Autonoma SDK defers unresolved `_ref`
  // fields until all aliases exist. If the scenario tree omits the
  // referenced EventType, the SDK either never resolves the booking's
  // FK (leaves it null) or patches it via a post-insert UPDATE. Either
  // way, the Booking.eventTypeId column is nullable, so accept missing
  // values here rather than hard-failing on incomplete trees.
  const hasEventTypeId =
    input.eventTypeId !== undefined &&
    input.eventTypeId !== null &&
    Number.isFinite(input.eventTypeId) &&
    input.eventTypeId > 0;
  if (!(input.startTime instanceof Date) || !(input.endTime instanceof Date)) {
    throw new ErrorWithCode(
      ErrorCode.RequestBodyInvalid,
      "createBookingForScenario: startTime and endTime must be Date instances",
    );
  }
  if (input.endTime <= input.startTime) {
    throw new ErrorWithCode(
      ErrorCode.RequestBodyInvalid,
      "createBookingForScenario: endTime must be after startTime",
    );
  }

  const uid = input.uid ?? (short.generate() as string);

  const created = await prisma.booking.create({
    data: {
      uid,
      title: input.title,
      description: input.description ?? null,
      startTime: input.startTime,
      endTime: input.endTime,
      status: input.status ?? BookingStatus.ACCEPTED,
      location: input.location ?? null,
      smsReminderNumber: input.smsReminderNumber ?? null,
      responses: input.responses ?? undefined,
      metadata: input.metadata ?? undefined,
      ...(hasEventTypeId
        ? { eventType: { connect: { id: input.eventTypeId as number } } }
        : {}),
      user: { connect: { id: input.userId } },
      ...(input.attendees && input.attendees.length > 0
        ? {
            attendees: {
              createMany: {
                data: input.attendees.map((attendee) => ({
                  name: attendee.name,
                  email: attendee.email,
                  timeZone: attendee.timeZone,
                  locale: attendee.locale ?? null,
                  phoneNumber: attendee.phoneNumber ?? null,
                })),
              },
            },
          }
        : {}),
    },
    select: {
      id: true,
      uid: true,
      title: true,
      startTime: true,
      endTime: true,
      status: true,
      userId: true,
      eventTypeId: true,
    },
  });

  return created;
}
