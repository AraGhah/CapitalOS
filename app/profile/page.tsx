import { requirePageActor } from "@/lib/auth/current";
import { getProfile } from "@/lib/profile";
import { getAccount } from "@/lib/cash";
import { ProfileForm } from "@/app/components/ProfileForm";
import { timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

// The questions about the person that come before any question about a
// stock. Every pre-investment checklist on the desk reads these answers.
export default async function ProfilePage() {
  const { actor } = await requirePageActor();
  const [profile, account] = await Promise.all([getProfile(actor.userId), getAccount(actor)]);

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Portfolio · before you invest</p>
          <h1>Investor profile</h1>
        </div>
        <span className="subtle">{profile.updatedAt ? `updated ${timeAgo(profile.updatedAt)}` : "not filled in yet"}</span>
      </div>
      <p className="subtle" style={{ marginBottom: "1rem", maxWidth: "48rem" }}>
        A stock can be an excellent business and still be the wrong investment for you. The pre-investment checklist on
        every research page — and the Copilot, before it suggests any stock — checks these answers first. Amounts are in{" "}
        {account.baseCurrency}, the currency your account reports in. Nothing leaves the desk.
      </p>
      <ProfileForm initial={profile} currency={account.baseCurrency} />
    </div>
  );
}
