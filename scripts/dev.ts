// Runs the Tailwind watcher and the server (with reload) together.
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const built = await Bun.spawn(["bun", "scripts/build-assets.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" }).exited;
if (built !== 0) process.exit(built);
const procs = [
  Bun.spawn(["bun", "scripts/build-assets.ts", "--watch"], { cwd: root, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--watch", "src/index.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" }),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(procs.map((p) => p.exited));
stop();
