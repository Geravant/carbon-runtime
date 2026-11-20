// Compiles the spike's own effects (../effects/*.fx, HLSL in Carbon's effect
// syntax) with the runtime's shader compiler into the containers the engine
// loads, for WebGPU:
//
//   node examples/shattered-spike/tools/build-effects.mjs
//
// `effects/<name>.fx` becomes `res/graphics/effect.webgpu/shattered/<name>.sm_{hi,lo,depth}`
// (Tr2Effect.convertEffectPath looks in `effect.<backend target>`; the suffix
// is the renderer-wide shader model). The page references them as
// `res:/graphics/effect/shattered/<name>.fx`. `--wgsl` also writes each stage's
// WGSL beside the containers, for reading.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompileEffectFile } from "../../../src/resource/shader/compiler/ShaderCompiler/shaderCompiler.js";
import { Platform } from "../../../src/resource/shader/compiler/platforms.js";
import { CjsFxEffectCompilerWebGPU } from "../../../src/resource/shader/compiler/EffectCompilerWebGPU/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "effects");
const tree = join(here, "..", "res", "graphics", "effect.webgpu");
// Where each source folder lands in the effect tree. `system/` holds our own files for the
// built-in paths the engine itself asks for (Tr2Blitter's blit effects).
const FOLDERS = [ [ "", "shattered" ], [ "system", "managed/space/system" ] ];
const SHADER_MODELS = [ "sm_hi", "sm_lo", "sm_depth" ];

const read = path =>
{
  const file = join(source, path.replace(/^\//u, ""));
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};

rmSync(tree, { recursive: true, force: true });

let failed = false;
for (const [ folder, target ] of FOLDERS)
for (const file of readdirSync(join(source, folder)).filter(entry => entry.endsWith(".fx")).sort())
{
  const name = folder ? `${folder}/${file}` : file;
  const out = join(tree, target);
  mkdirSync(out, { recursive: true });
  const compilers = new Map([ [ Platform.PLATFORM_WEBGPU, session => new CjsFxEffectCompilerWebGPU(session) ] ]);
  let compiled;
  try
  {
    compiled = CompileEffectFile(`/${name}`, { read, compilers, defines: [] });
  }
  catch (error)
  {
    compiled = { bytes: null, messages: [ error.stack ] };
  }
  if (!compiled.bytes)
  {
    failed = true;
    console.error(`${name} did not compile:\n${compiled.messages.join("\n")}`);
    continue;
  }
  if (compiled.messages.length) console.log(compiled.messages.join("\n"));
  const base = file.replace(/\.fx$/u, "");
  for (const model of SHADER_MODELS) writeFileSync(join(out, `${base}.${model}`), compiled.bytes);
  console.log(`res:/graphics/effect.webgpu/${target}/${base}.sm_* (${compiled.bytes.length} bytes)`);
}
if (failed) process.exit(1);
