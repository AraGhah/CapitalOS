import "../lib/env";
import { createInterface } from "node:readline/promises";
import { pool } from "../lib/db";
import { createUser, findUserByEmail, setPassword } from "../lib/auth/users";
import { revokeAllSessions } from "../lib/auth/sessions";
import { setupCode } from "../lib/auth/setup-code";

/* ---------------------------------------------------------------------------
   Account administration from the server's shell.

   npm run user -- create you@example.com      (prompts for a password)
   npm run user -- set-password you@example.com
   npm run user -- disable you@example.com     (and ends its sessions)
   npm run user -- enable you@example.com
   npm run user -- list
   npm run user -- setup-code                  (for claiming the desk remotely)

   A password can also be piped in: echo "…" | npm run user -- create x@y.z --stdin
--------------------------------------------------------------------------- */

async function readPassword(): Promise<string> {
  if (process.argv.includes("--stdin")) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const password = await rl.question("password (12+ characters): ");
  rl.close();
  return password;
}

async function main() {
  const [command, email] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  switch (command) {
    case "create": {
      if (!email) throw new Error("usage: npm run user -- create <email>");
      const user = await createUser(email, await readPassword(), null, { requestId: "cli" });
      console.log(`created ${user.email} (${user.id})`);
      break;
    }
    case "set-password": {
      const user = email ? await findUserByEmail(email) : null;
      if (!user) throw new Error(`no account with the e-mail ${email}`);
      await setPassword(user.id, await readPassword(), { requestId: "cli" });
      console.log(`password set for ${user.email}; every session it had is signed out`);
      break;
    }
    case "disable":
    case "enable": {
      const user = email ? await findUserByEmail(email) : null;
      if (!user) throw new Error(`no account with the e-mail ${email}`);
      await pool.query(`UPDATE users SET disabled_at = $2 WHERE id = $1`, [user.id, command === "disable" ? new Date() : null]);
      if (command === "disable") await revokeAllSessions(user.id);
      console.log(`${user.email} ${command}d`);
      break;
    }
    case "list": {
      const { rows } = await pool.query(
        `SELECT email, created_at, disabled_at, password_hash IS NOT NULL AS has_password FROM users ORDER BY created_at`
      );
      for (const r of rows) {
        console.log(
          `${r.email}  created ${(r.created_at as Date).toISOString().slice(0, 10)}` +
            `${r.has_password ? "" : "  (no password — unclaimed)"}${r.disabled_at ? "  DISABLED" : ""}`
        );
      }
      break;
    }
    case "setup-code":
      console.log(setupCode());
      break;
    default:
      throw new Error("commands: create, set-password, disable, enable, list, setup-code");
  }
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
