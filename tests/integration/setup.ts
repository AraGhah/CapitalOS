import { afterAll, beforeEach } from "vitest";

// lib/db builds its pool from DATABASE_URL on import, so this runs first.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET ??= "test-session-secret-0123456789abcdef0123456789";
process.env.SEC_USER_AGENT ??= "CapitalOS tests test@example.com";

const { resetDb } = await import("./db");
const { pool } = await import("../../lib/db");

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});
