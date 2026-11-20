// Textures from a host's own images: a URL (PNG, JPEG, WebP - whatever the browser decodes) or
// something already in memory (ImageBitmap, canvas, OffscreenCanvas, ImageData, <img>).
//
// The browser decodes; the pixels go straight to the device through the abstraction layer's
// external-image upload (the route the engine's video player uses), the same call on WebGPU
// and WebGL2. No engine file is edited and no pixel passes through JS.
//
// The engine's own route also works in the slim build: `res:/...png|jpg|jpeg` through resMan
// (shattered/src/configuration.js registers the extensions). That one decodes in JS on the main
// thread, so prefer LoadTexture for large images; use the resMan route where a path has to sit
// in a TriTextureParameter.
import { BitmapDimensions } from "../../src/global/imageio/index.js";
import { PixelFormat } from "../../src/global/consts/renderContext/formats.js";
import { Tr2CpuUsage, Tr2GpuUsage } from "../../src/global/consts/renderContext/index.js";
import { ALResult } from "../../src/trinityal/index.js";
import { Tr2TextureSubresource } from "../../src/trinityal/Tr2HalHelperStructures/Tr2TextureSubresource.js";
import { TriTextureRes } from "../../src/trinity/resources/texture/TriTextureRes.js";
import { Tr2RenderContext_GetMainThreadRenderContext } from "../../src/trinity/core/context/Tr2RenderContext.js";

const TOP_MIP = Tr2TextureSubresource.create__MipLevel(0);
let resRoot = null;
let backend = null;

/** Called by ShatteredBoot: where `res:/` resolves (LoadTexture takes the same paths effects do), and the backend in use. */
export function SetTextureHost(url, acquiredBackend)
{
  resRoot = String(url);
  backend = acquiredBackend;
}

function SizeOf(source)
{
  const width = source.naturalWidth ?? source.videoWidth ?? source.displayWidth ?? source.width;
  const height = source.naturalHeight ?? source.videoHeight ?? source.displayHeight ?? source.height;
  if (!(width > 0) || !(height > 0)) throw new RangeError("the image has no size (not decoded yet, or an empty canvas)");
  return { width, height };
}

function Upload(resource, source, mips)
{
  const context = Tr2RenderContext_GetMainThreadRenderContext();
  const texture = resource.GetTexture();
  const result = texture.UpdateSubresource(TOP_MIP, source, 0, 0, context);
  if (result !== ALResult.S_OK) throw new Error(`the device refused the image upload (ALResult ${result})`);
  if (!mips || texture.GetTrueMipCount() <= 1) return;
  if (backend?.webgpu)
  {
    // The WebGPU layer's own GenerateMipMaps records into the frame's command encoder and so only works
    // inside a render job. A loader runs between frames: the same mip generator on an encoder of its own,
    // submitted now (after the queued image copy, before the next frame's draws).
    const device = backend.webgpu.GetDevice();
    const encoder = device.createCommandEncoder({ label: "shattered texture mips" });
    // The facade has no accessor for its backend texture; `_texture.implementation` is how the layer itself
    // reaches it (trinityal/Tr2TextureAL/Tr2TextureAL.js). Check this line after an upstream merge.
    backend.al.GetMipGenerator().Encode(encoder, texture._texture.implementation.GetDeviceTexture());
    device.queue.submit([ encoder.finish() ]);
  }
  else texture.GenerateMipMaps(context);
}

/**
 * Makes a texture from an image already in memory.
 *
 * The texture is RGBA8, the image's bytes as they are (sRGB-encoded values, straight alpha, row 0
 * at v = 0), which is what a painted backdrop written to the canvas unchanged wants. Call after
 * `ShatteredBoot`.
 *
 * @param {ImageBitmap|HTMLCanvasElement|OffscreenCanvas|ImageData|HTMLImageElement} source The pixels.
 * @param {object} [options] Options.
 * @param {boolean} [options.mips=true] Build the mip chain (needed for trilinear filtering when drawn smaller).
 * @param {string} [options.name] A debug name; also the resource's `name`.
 * @returns {TriTextureRes} A good, prepared texture resource: hand it to
 *   `effect.SetParameter__TextureProvider(name, resource)` or a `TriTextureParameter.SetResource`.
 */
export function CreateTextureFromImage(source, { mips = true, name = "" } = {})
{
  const context = Tr2RenderContext_GetMainThreadRenderContext();
  if (!context?.IsValid()) throw new Error("CreateTextureFromImage needs a started device: call ShatteredBoot first");
  const { width, height } = SizeOf(source);
  const mipCount = mips ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
  // Render target as well as shader resource: what the layers require of a texture that takes an
  // external image and regenerates its mips.
  const texture = context.CreateTexture(
    BitmapDimensions.create__WidthHeightMipCountFormat(width, height, mipCount, PixelFormat.PIXEL_FORMAT_R8G8B8A8_UNORM),
    { gpuUsage: Tr2GpuUsage.SHADER_RESOURCE | Tr2GpuUsage.RENDER_TARGET, cpuUsage: Tr2CpuUsage.NONE });
  if (!texture?.IsValid()) throw new Error(`the device refused a ${width}x${height} texture`);
  if (name) texture.SetName(name);

  const resource = new TriTextureRes();
  resource.name = name;
  resource.width = width;
  resource.height = height;
  resource.depth = 1;
  resource.arraySize = 1;
  resource.cpuMip = mipCount;
  resource.format = PixelFormat.PIXEL_FORMAT_R8G8B8A8_UNORM;
  // As the engine's video player hands its texture to a resource (core/platform/VideoPlayer.js).
  resource._ownTexture = texture;
  resource.SetTexture(texture);
  resource._isGood = resource._isPrepared = true;
  resource._isLoading = false;
  Upload(resource, source, mips);
  return resource;
}

/**
 * Uploads a new picture into a texture made by `CreateTextureFromImage` (a procedural canvas that
 * was redrawn). The source must be the size the texture was made with.
 *
 * @param {TriTextureRes} resource The texture.
 * @param {ImageBitmap|HTMLCanvasElement|OffscreenCanvas|ImageData|HTMLImageElement} source The new pixels.
 * @param {object} [options] Options.
 * @param {boolean} [options.mips=true] Rebuild the mip chain.
 */
export function UpdateTextureFromImage(resource, source, { mips = true } = {})
{
  const texture = resource.GetTexture();
  if (!texture) throw new Error("UpdateTextureFromImage: the texture is gone (released, or the device was lost); make it again");
  const { width, height } = SizeOf(source);
  if (width !== texture.GetWidth() || height !== texture.GetHeight())
    throw new RangeError(`UpdateTextureFromImage: the image is ${width}x${height}, the texture ${texture.GetWidth()}x${texture.GetHeight()}`);
  Upload(resource, source, mips);
}

/**
 * Loads an image file into a texture: fetch, the browser's own decoder, one upload.
 *
 * @param {string|URL} url A `res:/` path (resolved like effect paths) or any URL the page may fetch.
 * @param {object} [options] `CreateTextureFromImage` options, plus:
 * @param {AbortSignal} [options.signal] Cancels the fetch.
 * @returns {Promise<TriTextureRes>} The texture; rejects when the file is missing or not an image.
 */
export async function LoadTexture(url, { mips = true, name = "", signal = undefined } = {})
{
  let href = String(url);
  if (href.startsWith("res:/"))
  {
    if (!resRoot) throw new Error("LoadTexture: res:/ paths need ShatteredBoot to have run");
    href = new URL(href.slice(5).replace(/^\/+/u, ""), resRoot).href;
  }
  const response = await fetch(href, { signal });
  if (!response.ok) throw new Error(`LoadTexture: ${href} answered ${response.status}`);
  // Straight alpha and no colour conversion: the bytes of the file reach the shader.
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try
  {
    return CreateTextureFromImage(bitmap, { mips, name: name || String(url) });
  }
  finally
  {
    bitmap.close();
  }
}
