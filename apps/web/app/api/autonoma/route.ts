import process from "node:process";
import { createHandler } from "@autonoma-ai/server-web";
import { createAutonomaAuth } from "@lib/autonoma/auth";
import { factories } from "@lib/autonoma/factories";

/**
 * Autonoma Environment Factory - seeds and tears down isolated test data for an
 * end-to-end run. See apps/web/lib/autonoma/IMPLEMENTATION.md.
 *
 * The endpoint is gated by the HMAC signature the SDK verifies against
 * AUTONOMA_SHARED_SECRET; unsigned or tampered requests get a 401. Both secrets
 * come from the environment - never hardcode them.
 */
export const POST = createHandler({
  // Cal.diy scopes organization data by organizationId (Profile, Watchlist,
  // DelegationCredential, DSyncData, IntegrationAttributeSync all key on it).
  scopeField: "organizationId",
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET ?? "",
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET ?? "",
  factories,
  auth: createAutonomaAuth,
});

// The factories write to the database on every call; nothing here is cacheable.
export const dynamic = "force-dynamic";
export const revalidate = 0;
