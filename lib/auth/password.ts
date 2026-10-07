import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/* ---------------------------------------------------------------------------
   Password hashing: scrypt (memory-hard, in node:crypto, no native addon),
   a random salt per password, parameters stored with the hash so they can be
   raised later without invalidating old hashes.

   Format: scrypt$N$r$p$<salt base64>$<hash base64>
--------------------------------------------------------------------------- */

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
// N × r × 128 bytes is 32 MiB; Node's default ceiling is exactly that, so it is raised.
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `a password needs at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `a password can be at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Spent on a sign-in for an address that does not exist, so the response time
// does not reveal which addresses have accounts.
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("not-a-real-password-for-timing");
  await verifyPassword(password, await dummyHash);
}
