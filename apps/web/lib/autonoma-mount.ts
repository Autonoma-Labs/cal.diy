/**
 * Canonical import point for the Autonoma Environment Factory handler.
 *
 * Next.js App Router auto-mounts `apps/web/app/api/autonoma/route.ts` at
 * `POST /api/autonoma` via filesystem convention, so no explicit
 * `app.use(...)` call is required for the endpoint to be reachable. This
 * file re-exports the handler so that:
 *
 *   1. The Autonoma SDK's factory-integrity check can prove, via a static
 *      cross-file import scan, that the handler is wired into the main
 *      application tree (the validator is framework-agnostic and doesn't
 *      know about Next.js's filesystem routing).
 *
 *   2. Scripts, health checks, or tests that want to invoke the handler
 *      programmatically have a single place to import it from — e.g. the
 *      scenario-validator in Step 5 calling `POST(req)` directly without
 *      spinning up the full Next dev server.
 *
 * Do not change the string `app/api/autonoma/route` below — the validator
 * grep is specifically looking for the `autonoma/route` path fragment.
 */
export { POST as autonomaHandler } from "../app/api/autonoma/route";
