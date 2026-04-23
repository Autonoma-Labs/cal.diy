/**
 * Temporary probe route — imports each dependency of the autonoma handler
 * one at a time and reports which one fails to resolve at runtime.
 *
 * DELETE THIS FILE after the real handler works.
 */
export const dynamic = "force-dynamic";

const probe = async (name: string, loader: () => Promise<unknown>) => {
  try {
    const mod = await loader();
    const keys =
      mod && typeof mod === "object" ? Object.keys(mod as Record<string, unknown>) : [];
    return { name, ok: true, keys };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      name,
      ok: false,
      error: err.message,
      stack: err.stack?.split("\n").slice(0, 4),
    };
  }
};

export async function GET() {
  const results = [
    await probe("@autonoma-ai/sdk", () => import("@autonoma-ai/sdk")),
    await probe("@autonoma-ai/sdk-prisma", () => import("@autonoma-ai/sdk-prisma")),
    await probe("@autonoma-ai/server-web", () => import("@autonoma-ai/server-web")),
    await probe("next-auth/jwt", () => import("next-auth/jwt")),
    await probe("@calcom/prisma", () => import("@calcom/prisma")),
    await probe("@calcom/prisma/enums", () => import("@calcom/prisma/enums")),
    await probe("@calcom/features/auth/lib/passwordResetRequest", () => import("@calcom/features/auth/lib/passwordResetRequest")),
    await probe("@calcom/features/auth/lib/verifyEmail", () => import("@calcom/features/auth/lib/verifyEmail")),
    await probe("@calcom/features/users/services/userCreationService", () => import("@calcom/features/users/services/userCreationService")),
    await probe("@calcom/features/bookings/lib/createBookingForScenario", () => import("@calcom/features/bookings/lib/createBookingForScenario")),
    await probe("@calcom/features/webhooks/lib/scheduleTrigger", () => import("@calcom/features/webhooks/lib/scheduleTrigger")),
    await probe("@calcom/trpc/server/routers/viewer/availability/schedule/create", () => import("@calcom/trpc/server/routers/viewer/availability/schedule/create")),
    await probe("@calcom/lib/server/avatar", () => import("@calcom/lib/server/avatar")),
    await probe("@calcom/features/eventtypes/repositories/eventTypeRepository", () => import("@calcom/features/eventtypes/repositories/eventTypeRepository")),
  ];
  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { "content-type": "application/json" },
  });
}
