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
import { TriDevice } from "../../src/trinity/core/device/TriDevice.js";

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

function IsCanvas(source)
{
  return (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement)
    || (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas);
}

function RebuildMips(texture, mips)
{
  if (!mips || texture.GetTrueMipCount() <= 1) return;
  const context = Tr2RenderContext_GetMainThreadRenderContext();
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

/** Writes tightly packed texels into a box of mip 0 (the layers' typed-array route, which takes a box on both backends). */
function WriteBox(texture, bytes, x, y, width, height, bytesPerTexel)
{
  const region = Tr2TextureSubresource.create__MipLevel(0).SetBox([ x, y, 0, x + width, y + height, 1 ]);
  const result = texture.UpdateSubresource(region, bytes, width * bytesPerTexel, width * height * bytesPerTexel,
    Tr2RenderContext_GetMainThreadRenderContext());
  if (result !== ALResult.S_OK) throw new Error(`the device refused the ${width}x${height} upload at ${x},${y} (ALResult ${result})`);
}

function Upload(resource, source, mips)
{
  const context = Tr2RenderContext_GetMainThreadRenderContext();
  const texture = resource.GetTexture();
  let result;
  try
  {
    result = texture.UpdateSubresource(TOP_MIP, source, 0, 0, context);
  }
  catch (error)
  {
    // WebGPU's copyExternalImageToTexture refuses a canvas that never had a drawing context
    // ("doesn't support canvas without rendering context"); WebGL2 takes it. Such a canvas holds
    // transparent black by definition, so that is what is written - with no context created on it.
    if (!IsCanvas(source)) throw error;
    const { width, height } = SizeOf(source);
    WriteBox(texture, new Uint8Array(width * height * 4), 0, 0, width, height, 4);
    result = ALResult.S_OK;
  }
  if (result !== ALResult.S_OK) throw new Error(`the device refused the image upload (ALResult ${result})`);
  RebuildMips(texture, mips);
}

/** RGBA8 bytes of a rectangle of any image source, top row first. */
function PixelsOf(source, x, y, width, height)
{
  if (typeof ImageData !== "undefined" && source instanceof ImageData)
  {
    if (x === 0 && y === 0 && width === source.width && height === source.height) return source.data;
    const out = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++)
      out.set(source.data.subarray(((y + row) * source.width + x) * 4, ((y + row) * source.width + x + width) * 4), row * width * 4);
    return out;
  }
  // Anything drawImage takes. The scratch canvas is 2D, so straight alpha comes back unpremultiplied, as the
  // whole-image route gives it (both round through the browser's premultiplied canvas storage).
  const scratch = new OffscreenCanvas(width, height);
  const context = scratch.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  context.clearRect(0, 0, width, height);
  context.drawImage(source, x, y, width, height, 0, 0, width, height);
  return context.getImageData(0, 0, width, height, { colorSpace: "srgb" }).data;
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
  // Made from memory, so nothing could load it again: keep the idle sweep (TriDevice.CollectResources,
  // which releases a device resource unused for TriDevice.resourceIdleRule seconds) away from it.
  // Release it yourself with ReleaseTexture.
  resource._neverPurge = true;
  Upload(resource, source, mips);
  return resource;
}

/**
 * Uploads a new picture into a texture made by `CreateTextureFromImage` (a procedural canvas that
 * was redrawn), whole or in part.
 *
 * - No `rect`, no `x`/`y`: the whole texture; the source must be the texture's size.
 * - `rect: { x, y, width, height }`: only that rectangle, read from the same rectangle of the source,
 *   which is the texture's size (the canvas the texture was made from, repainted in one place).
 * - `x`, `y` without `rect`: the whole source, which may be smaller, written with its top left corner there.
 *
 * A part goes through the layers' typed-array upload (`writeTexture` / `texSubImage2D` with an offset); an
 * `ImageData` source is read directly, anything else is read back through a 2D canvas the size of the part.
 *
 * @param {TriTextureRes} resource The texture.
 * @param {ImageBitmap|HTMLCanvasElement|OffscreenCanvas|ImageData|HTMLImageElement} source The new pixels.
 * @param {object} [options] Options.
 * @param {boolean} [options.mips=true] Rebuild the mip chain (the whole chain, on the GPU).
 * @param {{x: number, y: number, width: number, height: number}} [options.rect] The part to replace.
 * @param {number} [options.x] Where a smaller source goes.
 * @param {number} [options.y] Where a smaller source goes.
 */
export function UpdateTextureFromImage(resource, source, { mips = true, rect = null, x = undefined, y = undefined } = {})
{
  const texture = resource.GetTexture();
  if (!texture) throw new Error("UpdateTextureFromImage: the texture is gone (released, or the device was lost); make it again");
  const { width, height } = SizeOf(source);
  const textureWidth = texture.GetWidth(), textureHeight = texture.GetHeight();
  if (!rect && x === undefined && y === undefined)
  {
    if (width !== textureWidth || height !== textureHeight)
      throw new RangeError(`UpdateTextureFromImage: the image is ${width}x${height}, the texture ${textureWidth}x${textureHeight}`);
    Upload(resource, source, mips);
    return;
  }
  let box;
  if (rect)
  {
    if (width !== textureWidth || height !== textureHeight)
      throw new RangeError(`UpdateTextureFromImage: with a rect the image must be the texture's size (${textureWidth}x${textureHeight}), it is ${width}x${height}`);
    box = { x: rect.x | 0, y: rect.y | 0, width: rect.width | 0, height: rect.height | 0 };
  }
  else box = { x: x | 0, y: y | 0, width, height };
  if (box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0 || box.x + box.width > textureWidth || box.y + box.height > textureHeight)
    throw new RangeError(`UpdateTextureFromImage: ${box.width}x${box.height} at ${box.x},${box.y} is not inside the ${textureWidth}x${textureHeight} texture`);
  const pixels = rect ? PixelsOf(source, box.x, box.y, box.width, box.height) : PixelsOf(source, 0, 0, width, height);
  WriteBox(texture, pixels, box.x, box.y, box.width, box.height, 4);
  RebuildMips(texture, mips);
}

/**
 * Lets a texture made here go: frees its device texture now. The resource is no longer good afterwards.
 * Textures made by `CreateTextureFromImage`, `LoadTexture` and `CreateTextureFromData` are kept out of the
 * engine's idle sweep (they could not be loaded again), so this is how they are freed.
 *
 * @param {TriTextureRes} resource The texture.
 */
export function ReleaseTexture(resource)
{
  if (!resource) return;
  resource.ReleaseResources();
  // Out of the device's registry too, so the registry holds no reference to it.
  TriDevice.UnregisterResource(resource);
}

// Texel formats a data texture can take: the array type the texels arrive in, and channels per texel.
const DATA_FORMATS = Object.freeze({
  rgba32f: { pixel: PixelFormat.PIXEL_FORMAT_R32G32B32A32_FLOAT, channels: 4, bytes: 4, array: Float32Array },
  rg32f: { pixel: PixelFormat.PIXEL_FORMAT_R32G32_FLOAT, channels: 2, bytes: 4, array: Float32Array },
  r32f: { pixel: PixelFormat.PIXEL_FORMAT_R32_FLOAT, channels: 1, bytes: 4, array: Float32Array },
  rgba16f: { pixel: PixelFormat.PIXEL_FORMAT_R16G16B16A16_FLOAT, channels: 4, bytes: 2, array: Uint16Array },
  r16f: { pixel: PixelFormat.PIXEL_FORMAT_R16_FLOAT, channels: 1, bytes: 2, array: Uint16Array },
  rgba8: { pixel: PixelFormat.PIXEL_FORMAT_R8G8B8A8_UNORM, channels: 4, bytes: 1, array: Uint8Array }
});

const HALF_SCRATCH = new DataView(new ArrayBuffer(4));
/**
 * IEEE half-float bits of a number (round to nearest even), for `rgba16f` / `r16f` data given as numbers.
 *
 * @param {number} value The number.
 * @returns {number} The 16 bits.
 */
export function ToHalfFloat(value)
{
  HALF_SCRATCH.setFloat32(0, value);
  const bits = HALF_SCRATCH.getUint32(0);
  const sign = (bits >>> 16) & 0x8000, mantissa = bits & 0x7fffff;
  let exponent = (bits >>> 23) & 0xff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  exponent += 15 - 127;
  if (exponent >= 0x1f) return sign | 0x7c00;
  let half, rest, halfway;
  if (exponent <= 0)
  {
    if (exponent < -10) return sign;
    const shift = 14 - exponent, full = mantissa | 0x800000;
    half = full >>> shift;
    rest = full & ((1 << shift) - 1);
    halfway = 1 << (shift - 1);
  }
  else
  {
    half = (exponent << 10) | (mantissa >>> 13);
    rest = mantissa & 0x1fff;
    halfway = 0x1000;
  }
  if (rest > halfway || (rest === halfway && (half & 1))) half++;
  return sign | half;
}

function DataTexels(format, data, count)
{
  const spec = DATA_FORMATS[format];
  if (data instanceof spec.array) { if (data.length < count) throw new RangeError(`texture data: ${count} values needed, ${data.length} given`); return data; }
  if (spec.array === Uint16Array && (data instanceof Float32Array || Array.isArray(data)))
  {
    // Numbers for a half-float texture: converted here.
    if (data.length < count) throw new RangeError(`texture data: ${count} values needed, ${data.length} given`);
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = ToHalfFloat(data[i]);
    return out;
  }
  if (Array.isArray(data)) return DataTexels(format, spec.array.from(data), count);
  throw new TypeError(`texture data for ${format} is a ${spec.array.name}${spec.array === Uint16Array ? " (half-float bits) or a Float32Array" : ""}`);
}

/**
 * Makes a texture from numbers: a float data texture (positions, colours, marks, spans) a shader reads
 * texel by texel with `Load`, on WebGPU and WebGL2.
 *
 * Formats: `rgba32f`, `rg32f`, `r32f` (a `Float32Array`); `rgba16f`, `r16f` (a `Uint16Array` of half-float
 * bits, or a `Float32Array` / array of numbers, converted); `rgba8` (a `Uint8Array`, 0..255 read as 0..1).
 * Rows are tightly packed, row 0 first (row 0 is `Load( int3( x, 0, 0 ) )`).
 *
 * Read it with `Load`; that is the portable read. Filtered `Sample` of a 32-bit float texture needs the
 * `float32-filterable` feature on WebGPU and `OES_texture_float_linear` on WebGL2; 16-bit float filters
 * everywhere. No mips.
 *
 * @param {Float32Array|Uint16Array|Uint8Array|number[]} data The texels, `width * height * channels` values.
 * @param {number} width Texels across.
 * @param {number} height Texels down.
 * @param {object} [options] Options.
 * @param {"rgba32f"|"rg32f"|"r32f"|"rgba16f"|"r16f"|"rgba8"} [options.format="rgba32f"] The texel format.
 * @param {string} [options.name] A debug name.
 * @returns {TriTextureRes} A good texture resource, for `effect.SetParameter__TextureProvider(name, resource)`.
 */
export function CreateTextureFromData(data, width, height, { format = "rgba32f", name = "" } = {})
{
  const spec = DATA_FORMATS[format];
  if (!spec) throw new RangeError(`CreateTextureFromData: format must be one of ${Object.keys(DATA_FORMATS).join(", ")}`);
  const context = Tr2RenderContext_GetMainThreadRenderContext();
  if (!context?.IsValid()) throw new Error("CreateTextureFromData needs a started device: call ShatteredBoot first");
  if (!(width > 0) || !(height > 0)) throw new RangeError(`CreateTextureFromData: ${width}x${height} is no size`);
  // A shader resource the CPU writes; not a render target (32-bit float targets need an extension on WebGL2).
  const texture = context.CreateTexture(
    BitmapDimensions.create__WidthHeightMipCountFormat(width, height, 1, spec.pixel),
    { gpuUsage: Tr2GpuUsage.SHADER_RESOURCE, cpuUsage: Tr2CpuUsage.WRITE });
  if (!texture?.IsValid()) throw new Error(`the device refused a ${width}x${height} ${format} texture`);
  if (name) texture.SetName(name);
  const resource = new TriTextureRes();
  resource.name = name;
  resource.width = width;
  resource.height = height;
  resource.depth = 1;
  resource.arraySize = 1;
  resource.cpuMip = 1;
  resource.format = spec.pixel;
  resource._ownTexture = texture;
  resource.SetTexture(texture);
  resource._isGood = resource._isPrepared = true;
  resource._isLoading = false;
  resource._neverPurge = true;
  resource._shatteredDataFormat = format;
  UpdateTextureFromData(resource, data);
  return resource;
}

/**
 * Writes numbers into a texture made by `CreateTextureFromData`: all of it, or a rectangle.
 *
 * @param {TriTextureRes} resource The texture.
 * @param {Float32Array|Uint16Array|Uint8Array|number[]} data The texels of the rectangle, tightly packed.
 * @param {object} [options] Where: `x`, `y` (default 0, 0), `width`, `height` (default the whole texture).
 */
export function UpdateTextureFromData(resource, data, { x = 0, y = 0, width = undefined, height = undefined } = {})
{
  const texture = resource.GetTexture();
  if (!texture) throw new Error("UpdateTextureFromData: the texture is gone (released, or the device was lost); make it again");
  const format = resource._shatteredDataFormat;
  if (!format) throw new Error("UpdateTextureFromData takes a texture made by CreateTextureFromData");
  const spec = DATA_FORMATS[format];
  const w = width ?? texture.GetWidth() - x, h = height ?? texture.GetHeight() - y;
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > texture.GetWidth() || y + h > texture.GetHeight())
    throw new RangeError(`UpdateTextureFromData: ${w}x${h} at ${x},${y} is not inside the ${texture.GetWidth()}x${texture.GetHeight()} texture`);
  const texels = DataTexels(format, data, w * h * spec.channels);
  WriteBox(texture, texels.subarray(0, w * h * spec.channels), x, y, w, h, spec.channels * spec.bytes);
}

/**
 * Loads an image file into a texture: fetch, the browser's own decoder, one upload.
 *
 * @param {string|URL} url A `res:/` path (resolved like effect paths) or any URL the page may fetch.
 * @param {object} [options] `CreateTextureFromImage` options, plus:
 * @param {AbortSignal} [options.signal] Cancels the fetch.
 * @param {number} [options.maxSize=0] A cap on the longer side, in pixels: a bigger picture is scaled down
 *   (aspect kept, high-quality resampling) before upload, and the mips are built from that. 0: no cap.
 * @returns {Promise<TriTextureRes>} The texture; rejects when the file is missing or not an image.
 */
export async function LoadTexture(url, { mips = true, name = "", signal = undefined, maxSize = 0 } = {})
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
  const decode = { premultiplyAlpha: "none", colorSpaceConversion: "none" };
  let bitmap = await createImageBitmap(await response.blob(), decode);
  const longest = Math.max(bitmap.width, bitmap.height);
  if (maxSize > 0 && longest > maxSize)
  {
    // Scaled down by the browser before anything reaches the GPU; the mips are built from the scaled picture.
    const scale = maxSize / longest;
    const full = bitmap;
    bitmap = await createImageBitmap(full, { ...decode, resizeWidth: Math.max(1, Math.round(full.width * scale)),
      resizeHeight: Math.max(1, Math.round(full.height * scale)), resizeQuality: "high" });
    full.close();
  }
  try
  {
    return CreateTextureFromImage(bitmap, { mips, name: name || String(url) });
  }
  finally
  {
    bitmap.close();
  }
}
