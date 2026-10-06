import { createHmac, timingSafeEqual } from "node:crypto";

/** Synchronizer token bound to the session; complements Origin / Fetch Metadata checks. */
export function csrfToken(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("base64url").slice(0, 32);
}

export function verifyCsrfToken(secret: string, sessionId: string, token: string | undefined | null): boolean {
  if (!token) return false;
  const expected = Buffer.from(csrfToken(secret, sessionId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
