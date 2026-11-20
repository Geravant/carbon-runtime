// Bundles the spike page (../src/main.js over the runtime's built modules in npm/dist) into
// ../dist/spike.js with the repository's own esbuild, and reports what the page loads.
//
//   npm run build:npm                                   (once: makes npm/dist)
//   node examples/shattered-spike/tools/build-page.mjs  [--no-minify]
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outfile = join(root, "dist", "spike.js");
const result = await build({
  entryPoints: [ join(root, "src", "main.js") ],
  outfile,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !process.argv.includes("--no-minify"),
  sourcemap: process.argv.includes("--sourcemap"),
  metafile: true,
  logLevel: "warning"
});
writeFileSync(join(root, "dist", "meta.json"), JSON.stringify(result.metafile));
const bytes = readFileSync(outfile);
console.log(`dist/spike.js: ${statSync(outfile).size} bytes raw; ${gzipSync(bytes).length} bytes gzip; ${Object.keys(result.metafile.inputs).length} modules`);
