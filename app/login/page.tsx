import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/current";
import { config } from "@/lib/config";
import { legacyOwnerUnclaimed } from "@/lib/auth/users";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in · Capital OS" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await currentUser().catch(() => null)) redirect("/");
  const { next } = await searchParams;
  // Only a path on this site is followed after sign-in, never an absolute URL.
  // "//host" and "/\host" are both read by browsers as another site.
  const target = typeof next === "string" && /^\/(?![/\\])/.test(next) ? next : "/";

  return (
    <LoginForm
      next={target}
      claimable={await legacyOwnerUnclaimed().catch(() => false)}
      signup={config().ALLOW_SIGNUP}
    />
  );
}
