import { DEFAULT_SCHEDULE, getAvailabilityFromSchedule } from "@calcom/lib/availability";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";

import type { TCreateInputSchema } from "./create.schema";

// Extracted from the trpc `availability.schedule.create` handler so the Autonoma
// Environment Factory can reuse the real creation path (Schedule + nested
// Availability.createMany + optional User.defaultScheduleId update). The handler
// still performs auth and ownership checks; this helper owns the DB writes only.
// See autonoma/entity-audit.md.
export type CreateScheduleInput = {
  userId: number;
  userTimeZone: string;
  userDefaultScheduleId: number | null;
  input: TCreateInputSchema;
};

export const createSchedule = async ({
  userId,
  userTimeZone,
  userDefaultScheduleId,
  input,
}: CreateScheduleInput) => {
  const data: Prisma.ScheduleCreateInput = {
    name: input.name,
    user: {
      connect: {
        id: userId,
      },
    },
    ...(input.eventTypeId && { eventType: { connect: { id: input.eventTypeId } } }),
  };

  const availability = getAvailabilityFromSchedule(input.schedule || DEFAULT_SCHEDULE);
  data.availability = {
    createMany: {
      data: availability.map((slot) => ({
        days: slot.days,
        startTime: slot.startTime,
        endTime: slot.endTime,
      })),
    },
  };

  data.timeZone = userTimeZone;

  const schedule = await prisma.schedule.create({
    data,
  });

  if (!userDefaultScheduleId) {
    await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        defaultScheduleId: schedule.id,
      },
    });
  }

  return schedule;
};
