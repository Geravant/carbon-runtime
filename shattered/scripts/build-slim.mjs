// Builds the slim runtime (../src/index.js) into ../dist/: one ES module plus lazy chunks
// (the browser backend with WebGPU, the WebGL2 layer), from the engine's source.
//
//   node shattered/scripts/build-slim.mjs [--minify] [--analyze]
//
// The engine's source uses decorators (2023-11), which browsers and bundlers do not run, so each
// module on the way is transformed with the repository's own Babel setup (as rollup.config.mjs
// does), then bundled with the repository's esbuild. Only what the entry reaches is transformed;
// `npm run build:npm` is not needed. Transforms are cached under node_modules/.cache/shattered-slim.
//
// Three build-time substitutions keep EVE's composition out without touching engine files:
//   - the Trinity barrel as CjsLibrary imports it (every Trinity and EVE class) is replaced by
//     ../src/trinityForLibrary.js, the five names CjsLibrary uses from their own modules;
//   - core/configuration.js (the default format and resource registrations: Black, GR2, DDS, ...)
//     is replaced by ../src/configuration.js;
//   - the dynamic imports CjsLibrary keeps for SOF, character and audio resolve to an empty module
//     (they are only reached when a host asks for those services, which ShatteredBoot does not).
import { transformAsync } from "@babel/core";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const shattered = path.resolve(here, "..");
const root = path.resolve(shattered, "..");
const args = process.argv.slice(2);
const outdir = path.join(shattered, "dist");
const cacheDir = path.join(root, "node_modules", ".cache", "shattered-slim");
const sourceRequire = createRequire(path.join(root, "package.json"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
const src = path.join(root, "src") + path.sep;
const EMPTY = /[\\/]src[\\/](sof|character|audio)[\\/]/u;

const enginePlugin = {
  name: "shattered-engine-source",
  setup(b)
  {
    // Package `#` imports resolve through the source manifest, as rollup.config.mjs resolves them.
    b.onResolve({ filter: /^#/ }, args => ({ path: sourceRequire.resolve(args.path) }));
    b.onResolve({ filter: /configuration\.js$/ }, args =>
      args.importer.endsWith(path.join("src", "core", "CjsLibrary.js")) || args.importer.endsWith(path.join("src", "core", "index.js"))
        ? { path: path.join(shattered, "src", "configuration.js") } : null);
    b.onResolve({ filter: /trinity\/index\.js$/ }, args =>
      args.importer.endsWith(path.join("src", "core", "CjsLibrary.js")) ? { path: path.join(shattered, "src", "trinityForLibrary.js") } : null);
    b.onResolve({ filter: /^\./ }, args =>
    {
      if (args.kind !== "dynamic-import") return null;
      const target = path.resolve(args.resolveDir, args.path);
      return EMPTY.test(target) ? { path: target, namespace: "shattered-empty" } : null;
    });
    b.onLoad({ filter: /.*/, namespace: "shattered-empty" }, () => ({ contents: "export {};", loader: "js" }));
    b.onLoad({ filter: /\.js$/ }, async args =>
    {
      if (!args.path.startsWith(src) && !args.path.startsWith(shattered + path.sep)) return null;
      const code = await fs.promises.readFile(args.path, "utf8");
      // Only decorated modules need the transform.
      if (!/^\s*@[A-Za-z_$]/mu.test(code)) return { contents: code, loader: "js" };
      const key = createHash("sha1").update(args.path).update("\0").update(code).digest("hex");
      const cached = path.join(cacheDir, `${key}.js`);
      if (fs.existsSync(cached)) return { contents: await fs.promises.readFile(cached, "utf8"), loader: "js" };
      const result = await transformAsync(code, {
        filename: args.path, babelrc: false, configFile: false, sourceMaps: "inline", compact: false,
        plugins: [ [ "@babel/plugin-proposal-decorators", { version: "2023-11" } ] ]
      });
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(cached, result.code);
      return { contents: result.code, loader: "js" };
    });
  }
};

async function run(minify, write)
{
  return build({
    absWorkingDir: root,
    entryPoints: { index: path.join(shattered, "src", "index.js") },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify,
    sourcemap: false,
    legalComments: "eof",
    chunkNames: "chunks/[name]-[hash]",
    metafile: true,
    write,
    logLevel: "warning",
    external: [ "node:*" ],
    plugins: [ enginePlugin ]
  });
}

function report(result, label)
{
  const rows = [];
  for (const file of result.outputFiles ?? [])
  {
    if (file.path.endsWith(".map")) continue;
    rows.push({ file: path.relative(outdir, file.path), raw: file.contents.length, gzip: gzipSync(file.contents).length });
  }
  const meta = result.metafile.outputs;
  const entry = Object.entries(meta).find(([ , value ]) => value.entryPoint === "shattered/src/index.js");
  const eager = new Set([ path.relative(outdir, path.join(root, entry[0])) ]);
  // The chunks the entry imports statically, transitively: what a page always downloads.
  const queue = [ entry[0] ];
  while (queue.length)
  {
    for (const imported of meta[queue.pop()].imports)
    {
      if (imported.kind !== "import-statement" || imported.external) continue;
      const name = path.relative(outdir, path.join(root, imported.path));
      if (!eager.has(name)) { eager.add(name); queue.push(imported.path); }
    }
  }
  const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);
  const always = rows.filter(row => eager.has(row.file)), lazy = rows.filter(row => !eager.has(row.file));
  return { label, always: { files: always.length, raw: sum(always, "raw"), gzip: sum(always, "gzip") },
    lazy: lazy.map(row => ({ ...row })).sort((a, b) => b.raw - a.raw), total: { raw: sum(rows, "raw"), gzip: sum(rows, "gzip") } };
}

// Written unminified, so a consumer's dev server shows readable engine code; its production build minifies.
// The sizes reported are of a minified in-memory build of the same graph: what a production page loads.
fs.rmSync(outdir, { recursive: true, force: true });
const written = await run(args.includes("--minify"), true);
const measured = report(await run(true, false), "minified");
fs.writeFileSync(path.join(outdir, "sizes.json"), `${JSON.stringify(measured, null, 1)}\n`);

// The effect compiler as one Node module: the `carbon-fx` bin and the package's `./fx` export.
await build({
  absWorkingDir: root,
  entryPoints: [ path.join(here, "build-effects.mjs") ],
  outfile: path.join(outdir, "tools", "build-effects.mjs"),
  bundle: true, format: "esm", platform: "node", target: "node18", logLevel: "warning",
  plugins: [ enginePlugin ]
});
fs.chmodSync(path.join(outdir, "tools", "build-effects.mjs"), 0o755);
// `export *` drops a name two barrels export with different bindings, silently. Find such names:
// every star-exported barrel's own exports against what the entry ended up exporting.
{
  const entrySource = fs.readFileSync(path.join(shattered, "src", "index.js"), "utf8");
  const barrels = [ ...entrySource.matchAll(/^export \* from "([^"]+)";/gmu) ].map(match => path.resolve(shattered, "src", match[1]));
  // Read from the emitted `export { ... }` list: the metafile's `exports` still lists a dropped name.
  const names = text => new Set([ ...text.matchAll(/^export \{([^}]*)\};?$/gmu) ].flatMap(match => match[1].split(",")
    .map(part => part.trim().split(/\s+as\s+/u).pop()).filter(Boolean)));
  const exported = names(fs.readFileSync(path.join(outdir, "index.js"), "utf8"));
  const owners = new Map();
  for (const barrel of barrels)
  {
    const one = await build({ absWorkingDir: root, entryPoints: [ barrel ], bundle: true, format: "esm", platform: "browser", target: "es2022",
      write: false, logLevel: "silent", external: [ "node:*" ], outdir: path.join(outdir, "_"), plugins: [ enginePlugin ] });
    for (const name of names(one.outputFiles[0].text))
      owners.set(name, [ ...(owners.get(name) ?? []), path.relative(root, barrel) ]);
  }
  const dropped = [ ...owners ].filter(([ name ]) => !exported.has(name));
  if (dropped.length)
  {
    for (const [ name, from ] of dropped) console.error(`dropped export ${name}: exported by ${from.join(" and ")}; name its source in shattered/src/index.js`);
    process.exitCode = 1;
  }
  fs.writeFileSync(path.join(outdir, "exports.json"), `${JSON.stringify([ ...exported ].sort(), null, 0)}\n`);
  console.log(`exports: ${exported.size} names`);
}
if (args.includes("--analyze")) fs.writeFileSync(path.join(outdir, "meta.json"), JSON.stringify(written.metafile));
const kb = bytes => `${(bytes / 1024).toFixed(0)} KB`;
console.log(`slim runtime (${measured.label}): always loaded ${kb(measured.always.raw)} raw / ${kb(measured.always.gzip)} gzip in ${measured.always.files} file(s)`);
for (const row of measured.lazy) console.log(`  lazy ${row.file}: ${kb(row.raw)} raw / ${kb(row.gzip)} gzip`);
