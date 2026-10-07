"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { request } from "@/app/components/request";

export function SignOut({ email }: { email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await request("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <button type="button" className="chip" onClick={signOut} disabled={busy} title={`Signed in as ${email}`}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
