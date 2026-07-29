import process from "node:process";
import type { AuthContext, AuthResult } from "@autonoma-ai/sdk";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { defaultCookies } from "@calcom/lib/default-cookies";
import { encode } from "next-auth/jwt";

/**
 * The plaintext password the recipe seeds for every user. The UserPassword
 * factory hashes it with the app's own `hashPassword`, so both the returned
 * cookie and these credentials log in for real.
 */
const SEEDED_PASSWORD = "AutonomaTest123!";

/** 30 days - matches NextAuth's own default so long runs never expire mid-test. */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Mints a genuine NextAuth session. Cal.diy runs `strategy: "jwt"`, so a session
 * is an encrypted JWT in the session cookie - produced here with the same
 * `encode` from `next-auth/jwt` that `next-auth-options.ts` uses, keyed with the
 * same `NEXTAUTH_SECRET`, and named by the app's own `defaultCookies()`.
 * `getServerSession` then resolves the user from the token's `sub`.
 */
export async function createAutonomaAuth(
  user: Record<string, unknown> | null,
  _context: AuthContext
): Promise<AuthResult> {
  if (!user) return {};

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is not set - cannot mint a session for the seeded user");
  }

  const userId = Number(user.id);
  const email = typeof user.email === "string" ? user.email : undefined;
  if (!email) {
    throw new Error(`Seeded user ${userId} has no email - NextAuth cannot resolve a session without one`);
  }

  const sessionToken = await encode({
    secret,
    maxAge: SESSION_MAX_AGE_SECONDS,
    token: {
      // `getServerSession` reads `sub` and `email`, and falls back to
      // `usr-<id>` for upId when the token carries no profile.
      sub: String(userId),
      email,
      name: typeof user.name === "string" ? user.name : null,
      username: typeof user.username === "string" ? user.username : null,
      upId: `usr-${userId}`,
      locale: "en",
    },
  });

  const cookieName = defaultCookies(WEBAPP_URL.startsWith("https://")).sessionToken.name;
  const useSecureCookies = WEBAPP_URL.startsWith("https://");

  return {
    cookies: [
      {
        name: cookieName,
        value: sessionToken,
        httpOnly: true,
        // Cal.diy widens SameSite to `none` on HTTPS so the booker works in an
        // iframe; mirroring it keeps the cookie accepted in both setups.
        sameSite: useSecureCookies ? "none" : "lax",
        secure: useSecureCookies,
        path: "/",
        maxAge: SESSION_MAX_AGE_SECONDS,
      },
    ],
    // Also handed back so a test can drive the real /auth/login form.
    credentials: {
      email,
      password: SEEDED_PASSWORD,
    },
  };
}

export { SEEDED_PASSWORD };
