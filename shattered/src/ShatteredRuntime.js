// Boot helpers for a host with its own content: what the Shattered Reach spike learned about
// starting the engine without EVE's scene driver, in one place.
import { blue } from "../../src/blue/index.js";
import { CjsBlueResFileSystemFetch } from "../../src/blue/io/CjsBlueResFileSystemFetch.js";
import { CjsLibrary } from "../../src/core/CjsLibrary.js";
import { TR2SHADERMODEL } from "../../src/global/consts/graphics/trinityEnums.js";
import { Tr2Blitter } from "../../src/trinity/core/Tr2Blitter.js";
import { Tr2Renderer } from "../../src/trinity/core/Tr2Renderer.js";
import { Tr2RenderContext_GetMainThreadRenderContext } from "../../src/trinity/core/context/Tr2RenderContext.js";

const SHADER_MODELS = Object.freeze({
  depth: TR2SHADERMODEL.TR2SM_3_0_DEPTH, hi: TR2SHADERMODEL.TR2SM_3_0_HI, lo: TR2SHADERMODEL.TR2SM_3_0_LO
});

/**
 * Names the host's own files for the two effects the engine itself creates (Tr2Blitter's
 * point-sampled and linear-sampled blit). Call before `ShatteredBoot` / `AttachTrinity`: the
 * renderer constructs its blitter when Trinity starts.
 *
 * @param {object} paths The paths, as authored `res:` effect paths (`res:/graphics/effect/<...>.fx`).
 * @param {string} [paths.blit] The point-sampled blit effect.
 * @param {string} [paths.blitFiltered] The linear-sampled blit effect.
 */
export function SetBuiltInEffectPaths({ blit, blitFiltered } = {})
{
  if (blit) Tr2Blitter.blitEffectPath = blit;
  if (blitFiltered) Tr2Blitter.blitFilteredEffectPath = blitFiltered;
}

/**
 * Starts the engine on a canvas for a host that brings all of its own content: effects already
 * compiled for the backend (no DXBC translator), no ship assembly, character or audio services,
 * no callback workers.
 *
 * The effect tree follows the backend acquired: `effect.webgpu/` on WebGPU and `effect.webgl/`
 * on WebGL2, under the `res` root (scripts/build-effects.mjs writes both).
 *
 * Blue is host-pumped: resources only finish loading while something calls `blue.os.PumpOS()`,
 * and the same call runs the device's render jobs. The host owns that loop.
 *
 * @param {object} options Start-up options.
 * @param {HTMLCanvasElement} options.canvas The canvas to draw to, already sized in device pixels.
 * @param {string|URL} options.res Where `res:/` resolves, as a URL ending in `/`.
 * @param {string[]} [options.preference] Backends to try in order; default WebGPU then WebGL2.
 * @param {"depth"|"hi"|"lo"} [options.shaderModel="depth"] Which compiled suffix effects load (`.sm_depth`, ...).
 * @param {object} [options.effectPaths] `SetBuiltInEffectPaths` argument.
 * @param {"opaque"|"premultiplied"} [options.alphaMode="opaque"] Canvas compositing.
 * @param {object} [options.configuration] Further `CjsLibrary` configuration sections.
 * @returns {Promise<{library: CjsLibrary, backend: object, device: object, renderContext: object, effectTarget: string}>}
 */
export async function ShatteredBoot({ canvas, res, preference = [ "webgpu", "webgl2" ], shaderModel = "depth", effectPaths = null,
  alphaMode = "opaque", configuration = {} } = {})
{
  if (!Object.hasOwn(SHADER_MODELS, shaderModel)) throw new RangeError(`shaderModel must be one of ${Object.keys(SHADER_MODELS).join(", ")}`);
  if (effectPaths) SetBuiltInEffectPaths(effectPaths);

  const library = new CjsLibrary({ callbackMan: { useWorkers: false }, ...configuration });
  // translator: false - GetEffectConfiguration then names the backend's own effect tree.
  const backend = await library.AcquireBackend({ canvas, preference, alphaMode, shaderModel, translator: false });
  library.SetConfiguration({ paths: { host: new CjsBlueResFileSystemFetch({ paths: { res: new URL(res, globalThis.location?.href).href } }) } });
  // Explicit nulls: with the keys absent, Initialize constructs EVE's SOF and character library.
  await library.Initialize({ sof: null, characterLibrary: null });
  const device = library.AttachTrinity({ renderContextAL: backend.al, backend: backend.name });
  Tr2Renderer.SetShaderModel(SHADER_MODELS[shaderModel]);
  device.width = canvas.width;
  device.height = canvas.height;
  return {
    library, backend, device,
    renderContext: Tr2RenderContext_GetMainThreadRenderContext(),
    effectTarget: backend.name === "webgpu" ? "webgpu" : "webgl",
    blue
  };
}
