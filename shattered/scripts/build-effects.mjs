#!/usr/bin/env node
// Compiles a host's own effects (HLSL `.fx` in Carbon's effect syntax) with the runtime's shader
// compiler into the containers the engine loads, for WebGPU (WGSL) and WebGL2 (GLSL ES 3.00).
//
//   node shattered/scripts/build-effects.mjs --src <effects dir> --out <res root> [--prefix <folder>]
//        [--targets webgpu,webgl] [--models depth,hi,lo] [--text] [--clean]
//
// From a game that depends on the packed runtime the same script is the `carbon-fx` bin, and
// `BuildEffects` is importable from `@geravant/carbon-runtime-slim/fx`.
//
// `<src>/a/b/name.fx` becomes `<out>/graphics/effect.<target>/<prefix>/a/b/name.sm_<model>`, which the
// page names `res:/graphics/effect/<prefix>/a/b/name.fx` (Tr2Effect swaps in the backend's tree and
// the renderer-wide shader model). `.fxh` files are includes, found relative to `--src`.
// `--text` also writes each container's shader text beside it, for reading.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { CompileEffectFile } from "../../src/resource/shader/compiler/ShaderCompiler/shaderCompiler.js";
import { Platform } from "../../src/resource/shader/compiler/platforms.js";
import { Macro } from "../../src/resource/shader/compiler/Macro.js";
import { CjsFxEffectCompilerWebGPU } from "../../src/resource/shader/compiler/EffectCompilerWebGPU/index.js";
import { CjsFxEffectCompilerWebGL2 } from "../../src/resource/shader/compiler/EffectCompilerWebGL2/index.js";

/** The effect trees this compiler writes, by the name `ShatteredBoot` reports as `effectTarget`. */
const TARGETS = {
  webgpu: { tree: "effect.webgpu", defines: () => [], compilers: () => new Map([ [ Platform.PLATFORM_WEBGPU, session => new CjsFxEffectCompilerWebGPU(session) ] ]) },
  webgl: { tree: "effect.webgl", defines: () => [ new Macro("PLATFORM", "webgl2") ], compilers: () => new Map([ [ Platform.PLATFORM_WEBGL2, session => new CjsFxEffectCompilerWebGL2(session) ] ]) }
};
const MODELS = { depth: "sm_depth", hi: "sm_hi", lo: "sm_lo" };

function list(directory, base = directory)
{
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return list(target, base);
    return entry.name.endsWith(".fx") ? [ relative(base, target).split(sep).join("/") ] : [];
  }).sort();
}

/**
 * Compiles every `.fx` under `src` for each target.
 *
 * @param {object} options The build.
 * @param {string} options.src Directory of `.fx` and `.fxh` sources.
 * @param {string} options.out The `res:` root to write under (`<out>/graphics/effect.<target>/...`).
 * @param {string} [options.prefix=""] Folder under the effect tree.
 * @param {string[]} [options.targets] `webgpu`, `webgl`; default both.
 * @param {string[]} [options.models] `depth`, `hi`, `lo`; default all three (the same container under each suffix).
 * @param {boolean} [options.clean=false] Remove `<tree>/<prefix>` before writing.
 * @param {(line: string) => void} [options.log] Receives progress and compiler messages.
 * @returns {{ written: string[], failed: {effect: string, target: string, messages: string[]}[] }}
 */
export function BuildEffects({ src, out, prefix = "", targets = Object.keys(TARGETS), models = Object.keys(MODELS), clean = false, log = () => {} })
{
  const source = resolve(src);
  const read = path =>
  {
    const file = join(source, path.replace(/^\/+/u, ""));
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  const written = [], failed = [];
  for (const target of targets)
  {
    const spec = TARGETS[target];
    if (!spec) throw new RangeError(`unknown target ${target}; expected ${Object.keys(TARGETS).join(" or ")}`);
    const tree = join(resolve(out), "graphics", spec.tree, prefix);
    if (clean) rmSync(tree, { recursive: true, force: true });
    for (const effect of list(source))
    {
      let compiled;
      try
      {
        compiled = CompileEffectFile(`/${effect}`, { read, compilers: spec.compilers(), defines: spec.defines() });
      }
      catch (error)
      {
        compiled = { bytes: null, messages: [ String(error?.stack ?? error) ] };
      }
      if (!compiled.bytes)
      {
        failed.push({ effect, target, messages: compiled.messages });
        log(`${target} ${effect}: did not compile\n${compiled.messages.join("\n")}`);
        continue;
      }
      for (const message of compiled.messages) log(`${target} ${effect}: ${message}`);
      const base = join(tree, effect.replace(/\.fx$/u, ""));
      mkdirSync(dirname(base), { recursive: true });
      for (const model of models)
      {
        if (!MODELS[model]) throw new RangeError(`unknown shader model ${model}`);
        writeFileSync(`${base}.${MODELS[model]}`, compiled.bytes);
        written.push(`${base}.${MODELS[model]}`);
      }
      log(`${target} ${effect}: ${compiled.bytes.length} bytes`);
    }
  }
  return { written, failed };
}

// Run as a script (directly, or through the package's bin link), not imported.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
{
  const args = process.argv.slice(2);
  const option = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const src = option("--src"), out = option("--out");
  if (!src || !out)
  {
    console.error("usage: build-effects --src <effects dir> --out <res root> [--prefix <folder>] [--targets webgpu,webgl] [--models depth,hi,lo] [--clean]");
    process.exit(2);
  }
  const result = BuildEffects({
    src, out, prefix: option("--prefix", ""), clean: args.includes("--clean"),
    targets: option("--targets", "webgpu,webgl").split(","), models: option("--models", "depth,hi,lo").split(","),
    log: line => console.log(line)
  });
  console.log(`${result.written.length} containers written, ${result.failed.length} failed`);
  if (result.failed.length) process.exit(1);
}
