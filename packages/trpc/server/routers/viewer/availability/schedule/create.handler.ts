import { prisma } from "@calcom/prisma";

import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../../types";
import { createSchedule } from "./create";
import type { TCreateInputSchema } from "./create.schema";

type CreateOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id" | "timeZone" | "defaultScheduleId">;
  };
  input: TCreateInputSchema;
};

export type CreateScheduleHandlerReturn = Awaited<ReturnType<typeof createHandler>>;

export const createHandler = async ({ input, ctx }: CreateOptions) => {
  const { user } = ctx;
  if (input.eventTypeId) {
    const eventType = await prisma.eventType.findUnique({
      where: {
        id: input.eventTypeId,
      },
      select: {
        userId: true,
      },
    });
    if (!eventType || eventType.userId !== user.id) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "You are not authorized to create a schedule for this event type",
      });
    }
  }

  const schedule = await createSchedule({
    userId: user.id,
    userTimeZone: user.timeZone,
    userDefaultScheduleId: user.defaultScheduleId,
    input,
  });

  return { schedule };
};
