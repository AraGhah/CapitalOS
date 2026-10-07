import { z } from "zod";

/* ---------------------------------------------------------------------------
   Errors that know their HTTP status. Anything else that reaches a route
   handler is an internal error: logged in full, answered with a request id
   and a generic message, never with the database's or a provider's text.
--------------------------------------------------------------------------- */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = codeFor(status),
    readonly details?: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function codeFor(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "too_large";
    case 422:
      return "unprocessable";
    case 429:
      return "rate_limited";
    case 503:
      return "unavailable";
    default:
      return "error";
  }
}

export const unauthorized = () => new HttpError(401, "sign in to use the desk");
export const notFound = (what = "not found") => new HttpError(404, what);

// Errors from the domain layer carry a status of their own (LedgerError 422,
// NotFoundError 404, AuthError 401/409/429, budget errors 429…). Only those
// statuses are trusted; everything else is a 500.
export function statusOf(err: unknown): number | null {
  if (err instanceof HttpError) return err.status;
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) return status;
  const name = (err as { name?: string })?.name;
  if (name === "LockTimeoutError") return 409;
  if (name === "ConfigError") return 503;
  return null;
}

// Request bodies are parsed against a schema; the first few problems are
// reported in words a person can act on.
export async function parseJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "the body must be JSON");
  }
  return parseWith(schema, raw);
}

export function parseWith<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .slice(0, 5)
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
    throw new HttpError(
      400,
      problems.join("; "),
      "invalid_input",
      result.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message }))
    );
  }
  return result.data;
}
