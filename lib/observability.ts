import { errorFields, log } from "./log";

/* ---------------------------------------------------------------------------
   Error reporting. Every unexpected error is logged with its request id; when
   SENTRY_DSN is set it is also sent to Sentry (wired in instrumentation.ts,
   which registers a reporter here so this module has no SDK dependency).
--------------------------------------------------------------------------- */

type Reporter = (err: unknown, context: Record<string, unknown>) => void;

let reporter: Reporter | null = null;

export function setErrorReporter(fn: Reporter | null): void {
  reporter = fn;
}

export function reportError(err: unknown, context: Record<string, unknown> = {}): void {
  log.error({ ...context, ...errorFields(err) }, "unexpected error");
  try {
    reporter?.(err, context);
  } catch {
    // reporting must never become the failure
  }
}
