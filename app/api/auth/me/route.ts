import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, { user }) =>
  Response.json({
    email: user.email,
    displayName: user.displayName,
    accountId: user.accountId,
    baseCurrency: user.baseCurrency,
    sessionExpiresAt: user.expiresAt.toISOString(),
  })
);
