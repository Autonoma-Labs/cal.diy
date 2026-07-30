import { Prisma } from "@calcom/prisma/client";

/**
 * Teardown has to survive being a no-op: most rows we seed hang off a Team or a
 * User, and deleting those roots cascades the subtree away before the SDK walks
 * down to the individual records. Prisma reports the already-gone row as P2025.
 */
export async function safeDelete(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return;
    throw error;
  }
}

/**
 * Instance-level singletons live at a fixed id shared by every concurrent test
 * run against one database, so looking the row up and then creating it is a
 * check-then-act race: two runs both see nothing and the loser fails on P2002.
 * Adopt whatever the winner inserted instead.
 */
export async function createOrAdopt<T>(create: () => Promise<T>, adopt: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return adopt();
    throw error;
  }
}

/**
 * Composite-key models have no single-column id, but the SDK requires every
 * `create` to return an `id` it can round-trip through the refs token. We return
 * a joined string and split it back apart in teardown.
 */
export function compositeId(...parts: (string | number)[]): string {
  return parts.join("::");
}

export function splitCompositeId(id: string | number): string[] {
  return String(id).split("::");
}

/** Time-only columns (`Availability.startTime`) are stored on the epoch date. */
export function timeOnly(hhmm: string): Date {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(1970, 0, 1, hours, minutes, 0, 0));
}

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return (value ?? {}) as Prisma.InputJsonValue;
}

/**
 * `BookingAuditCreateInput.data` is typed with the read-side `JsonValue` instead
 * of Prisma's write-side `InputJsonValue`, and the two are not assignable to one
 * another. Writes through that repository need this variant.
 */
export function toJsonValueReadShape(value: unknown): Prisma.JsonValue {
  return (value ?? null) as Prisma.JsonValue;
}
