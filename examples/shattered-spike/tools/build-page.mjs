// Bundles the spike page (../src/main.js) over the packed slim runtime into ../dist/, the way a
// game would consume it: the tarball shattered/scripts/pack.mjs wrote is installed into
// tools/node_modules and the page imports "@geravant/carbon-runtime-slim" from there.
//
//   node shattered/scripts/pack.mjs                      (once per engine change)
//   node examples/shattered-spike/tools/build-page.mjs   [--no-minify]
//
// Reports what the page loads: the entry and the chunks it imports statically, and the lazy chunks.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const latest = JSON.parse(readFileSync(join(root, "..", "..", "shattered", "pack", "latest.json"), "utf8"));
const installedManifest = join(here, "node_modules", "@geravant", "carbon-runtime-slim", "package.json");
const installed = existsSync(installedManifest) ? JSON.parse(readFileSync(installedManifest, "utf8")) : null;
if (installed?.version !== latest.version || process.argv.includes("--reinstall"))
{
  rmSync(join(here, "node_modules", "@geravant"), { recursive: true, force: true });
  execFileSync("npm", [ "install", "--no-save", "--no-audit", "--no-fund", latest.tarball ], { cwd: here, stdio: "inherit" });
}
const runtime = JSON.parse(readFileSync(installedManifest, "utf8"));

const outdir = join(root, "dist");
rmSync(outdir, { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: { spike: join(root, "src", "main.js"), scene: join(root, "src", "scene.js"), requests: join(root, "src", "requests.js") },
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  target: "es2022",
  minify: !process.argv.includes("--no-minify"),
  chunkNames: "chunks/[name]-[hash]",
  nodePaths: [ join(here, "node_modules") ],
  metafile: true,
  logLevel: "warning"
});
const outputs = result.metafile.outputs;
const size = file => { const bytes = readFileSync(join(root, file)); return { raw: bytes.length, gzip: gzipSync(bytes).length }; };
const eager = new Set([ "dist/spike.js" ]);
const queue = [ "dist/spike.js" ];
while (queue.length)
  for (const imported of outputs[queue.pop()].imports)
    if (imported.kind === "import-statement" && !eager.has(imported.path)) { eager.add(imported.path); queue.push(imported.path); }
const total = { raw: 0, gzip: 0 }, lazy = [];
for (const file of Object.keys(outputs))
{
  const measured = size(file);
  if (eager.has(file)) { total.raw += measured.raw; total.gzip += measured.gzip; }
  else if (measured.raw > 1024) lazy.push({ file: relative("dist", file), ...measured });
}
const report = { runtime: runtime.version, commit: runtime.carbon.commit, alwaysLoaded: { files: eager.size, ...total }, lazy: lazy.sort((a, b) => b.raw - a.raw) };
writeFileSync(join(outdir, "sizes.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(`runtime ${runtime.version}`);
console.log(`always loaded: ${eager.size} files, ${total.raw} bytes raw, ${total.gzip} bytes gzip`);
for (const row of lazy) console.log(`  lazy ${row.file}: ${row.raw} raw, ${row.gzip} gzip`);
