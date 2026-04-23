/**
 * Autonoma Environment Factory route.
 *
 * Thin dispatcher with an error envelope — the 1000-line handler lives in
 * ./handler.ts and is only loaded on first request. The envelope turns
 * otherwise-invisible module-load errors into a readable JSON response so
 * diagnosis does not require Vercel runtime log access.
 */
export const dynamic = "force-dynamic";

let handlerPromise: Promise<typeof import("./handler")> | undefined;

const loadHandler = async () => {
  if (!handlerPromise) {
    handlerPromise = import("./handler");
  }
  return handlerPromise;
};

export async function POST(request: Request) {
  try {
    const { POST: impl } = await loadHandler();
    return (impl as unknown as (req: Request) => Promise<Response> | Response)(
      request,
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return new Response(
      JSON.stringify({
        error: "autonoma handler failed to load or execute",
        name: err.name,
        message: err.message,
        stack: err.stack?.split("\n").slice(0, 20),
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}
