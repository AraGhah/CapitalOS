// Who is acting: the signed-in person, the account their writes land in, and
// the request they came from (for the audit log). Every function that reads or
// writes someone's data takes one of these instead of a hard-coded id.
export interface Actor {
  userId: string;
  accountId: string;
  requestId?: string | null;
  ip?: string | null;
}

// The owner the identity migration created for everything that existed before
// accounts did. Only migrations, scripts and tests refer to it by id.
export const LEGACY_OWNER_ID = "00000000-0000-0000-0000-000000000001";
export const LEGACY_ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";
