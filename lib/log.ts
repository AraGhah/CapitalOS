import pino from "pino";
import { config } from "./config";

/* ---------------------------------------------------------------------------
   One structured logger for the web server, the worker, the scripts and the
   MCP server. JSON lines on stdout (stderr for MCP, whose stdout is the
   protocol), so any collector can ship them.

   Never log a session token, an API key, a brokerage token, a password or a
   prompt carrying portfolio data: the redact list strips the usual suspects
   if one slips into an object anyway.
--------------------------------------------------------------------------- */

const REDACT = [
  "password",
  "*.password",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "apiKey",
  "*.apiKey",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "headers.cookie",
  "cookie",
  "*.cookie",
  "secret",
  "*.secret",
  "userSecret",
  "*.userSecret",
];

function create(): pino.Logger {
  let level: pino.LevelWithSilent = "info";
  try {
    level = config().LOG_LEVEL;
  } catch {
    // An invalid config is reported by whoever reads it; logging still works.
  }
  if (process.env.NODE_ENV === "test" && !process.env.LOG_LEVEL) level = "silent";

  const destination = process.env.CAPITALOS_LOG_STDERR === "1" ? pino.destination(2) : undefined;
  return pino(
    {
      level,
      base: { service: process.env.CAPITALOS_SERVICE ?? "capitalos" },
      redact: { paths: REDACT, censor: "[redacted]" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination
  );
}

export const log = create();

// A one-line summary of anything thrown, for log fields and client-safe codes.
export function errorFields(err: unknown): { err: { name: string; message: string; stack?: string; code?: string } } {
  if (err instanceof Error) {
    return {
      err: {
        name: err.name,
        message: err.message,
        stack: err.stack,
        code: (err as { code?: string }).code,
      },
    };
  }
  return { err: { name: "NonError", message: String(err) } };
}
