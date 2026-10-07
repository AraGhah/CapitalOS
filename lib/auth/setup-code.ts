import { createHmac, timingSafeEqual } from "node:crypto";
import { sessionSecret } from "./cookie";

// Claiming the unclaimed desk from anywhere but the machine it runs on needs
// this code, printed by `npm run user -- setup-code`. It is derived from
// SESSION_SECRET, so only someone who can read the server configuration can
// produce it.
export function setupCode(): string {
  return createHmac("sha256", sessionSecret()).update("claim-legacy-owner").digest("base64url").slice(0, 16);
}

export function setupCodeMatches(given: string | undefined | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(setupCode());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopbackHost(host: string | null): boolean {
  const h = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}
