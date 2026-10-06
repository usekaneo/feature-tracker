import { copyFileSync, mkdirSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const root = join(import.meta.dir, "..");
const out = join(root, "public/assets");
mkdirSync(out, { recursive: true });
copyFileSync(join(root, "node_modules/htmx.org/dist/htmx.min.js"), join(out, "htmx.min.js"));
copyFileSync(join(root, "node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2"), join(out, "geist.woff2"));
const CLIENT_SCRIPTS = ["theme.js", "keys.js"];
async function build() {
  const input = join(root, "src/styles/app.css");
  const compiler = await compile(await Bun.file(input).text(), { base: dirname(input), onDependency() {} });
  const sources = compiler.root === "none" ? [] : [{ ...(compiler.root ?? { base: root, pattern: "**/*" }), negated: false }];
  const scanner = new Scanner({ sources: [...sources, ...compiler.sources] });
  const css = optimize(compiler.build(scanner.scan()), { file: input, minify: true }).code;
  await Bun.write(join(out, "app.css"), css);
  // Refresh static assets during development too.
  for (const name of CLIENT_SCRIPTS) copyFileSync(join(root, "src/client", name), join(out, name));
  for (const name of ["kaneo-logo-dark.svg", "kaneo-logo-light.svg"]) copyFileSync(join(root, "src/assets", name), join(out, name));
  console.log("Assets built in public/assets");
}

await build();
if (process.argv.includes("--watch")) {
  let running = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rebuild = async () => {
    if (running) { dirty = true; return; }
    running = true;
    do {
      dirty = false;
      try { await build(); } catch (error) { console.error("Asset build failed", error); }
    } while (dirty);
    running = false;
  };
  const watcher = watch(join(root, "src"), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 100);
  });
  const stop = () => { clearTimeout(timer); watcher.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("Watching src/ for asset changes");
}
