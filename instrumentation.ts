import type { Instrumentation } from "next";

/* ---------------------------------------------------------------------------
   Observability for the web server, loaded once at start-up.

   - Traces: OpenTelemetry through @vercel/otel, exported over OTLP when
     OTEL_EXPORTER_OTLP_ENDPOINT is set (Grafana Tempo, Honeycomb, Datadog…).
     Incoming requests and outgoing fetches (model providers, SEC, market
     data) become spans.
   - Errors: Sentry, when SENTRY_DSN is set. lib/observability's reporter is
     pointed at it, so route handlers, the job worker and React render errors
     all land in one place.
   - Logs: pino JSON on stdout, always (lib/log.ts).
--------------------------------------------------------------------------- */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const { registerOTel } = await import("@vercel/otel");
    registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? "capitalos-web" });
  }

  if (process.env.SENTRY_DSN) {
    const Sentry = await import("@sentry/node");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0,
      // No request bodies, cookies or headers: they can carry sessions and
      // portfolio data.
      sendDefaultPii: false,
    });
    const { setErrorReporter } = await import("./lib/observability");
    setErrorReporter((err, context) => {
      Sentry.captureException(err, { extra: context });
    });
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { reportError } = await import("./lib/observability");
  reportError(err, {
    path: request.path,
    method: request.method,
    routerKind: context.routerKind,
    routeType: context.routeType,
    digest: typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : undefined,
  });
};
