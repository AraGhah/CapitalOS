// npm run dev:all — the web server and a worker together, for local
// development. Ctrl-C stops both.
import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
const children = [
  spawn(npm, ["run", "dev"], { stdio: "inherit", shell: isWin }),
  spawn(npm, ["run", "worker"], { stdio: "inherit", shell: isWin }),
];

function stop() {
  for (const c of children) if (!c.killed) c.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => {
  stop();
  process.exitCode = code ?? 0;
});
