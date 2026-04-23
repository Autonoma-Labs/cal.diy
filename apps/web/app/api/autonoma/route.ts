/**
 * Autonoma Environment Factory route.
 *
 * Thin dispatcher — the 1000-line handler with its full repository /
 * service import graph lives in ./handler.ts. We defer loading it until
 * the first real request so Next.js's build-time page-data collector
 * never evaluates the heavy import tree. That matters because the
 * collector loads every route module for metadata extraction, and
 * evaluating the full Cal.com server-side graph there has historically
 * tripped "TypeError: (void 0) is not a function" under Turbopack when
 * an intermediate module's ESM shape is not yet resolved.
 */
export const dynamic = "force-dynamic";

type NextRouteContext = Parameters<
  typeof import("./handler").POST
>[1] extends infer C
  ? C
  : never;

let handlerPromise: Promise<typeof import("./handler")> | undefined;

const loadHandler = async () => {
  if (!handlerPromise) {
    handlerPromise = import("./handler");
  }
  return handlerPromise;
};

export async function POST(request: Request, context: NextRouteContext) {
  const { POST: impl } = await loadHandler();
  return impl(request, context);
}
