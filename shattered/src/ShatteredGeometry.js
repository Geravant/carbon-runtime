// Geometry a host builds in memory (TriGeometryRes.PrepareFromCmfData): how to let it go, and what it holds.
//
// Where the bytes live: the first draw of a geometry copies its vertices and indices into the engine's ONE
// shared, sub-allocated device buffer (TriGeometryResAllocations.SharedGeometryBuffer: 32 MB blocks, up to
// 2 GB). The geometry holds slices of it. The pool also lists every slice it handed out, and the device's
// resource registry lists every geometry that was drawn. So dropping your references frees nothing: the
// slices stay reserved and the geometry stays reachable. Release it explicitly.
import { TriStorageFlags } from "../../src/global/consts/graphics/index.js";
import { TriDevice } from "../../src/trinity/core/device/TriDevice.js";
import { SharedGeometryBuffer } from "../../src/trinity/core/mesh/TriGeometryResAllocations.js";
import { Tr2RenderContext_GetMainThreadRenderContext } from "../../src/trinity/core/context/Tr2RenderContext.js";

/**
 * Lets a geometry made with `PrepareFromCmfData` go, at once: its slices of the shared device buffer go
 * back to the pool (the next geometry reuses them), its CPU copies are dropped, and the device registry
 * forgets it. Meshes still holding it draw nothing from then on (the resource is no longer good); drop them
 * too. The pool's blocks themselves stay allocated for reuse; nothing is handed back to the browser.
 *
 * Safe to call twice, and on a geometry never drawn.
 *
 * @param {object} geometry A `TriGeometryRes`.
 */
export function ReleaseGeometry(geometry)
{
  if (!geometry) return;
  geometry.ReleaseResources(TriStorageFlags.TRISTORAGE_ALL);
  TriDevice.UnregisterResource(geometry);
}

/**
 * What the shared geometry buffer holds now: for a leak check, or a test that releasing works.
 *
 * @returns {{allocations: number, bytes: number, blocks: number, blockBytes: number}} Live slices, their bytes,
 *   and the device blocks backing them.
 */
export function GeometryPoolStats()
{
  const pool = SharedGeometryBuffer(Tr2RenderContext_GetMainThreadRenderContext());
  const allocations = pool._allocations;
  let bytes = 0;
  for (const allocation of allocations) bytes += allocation._size;
  const blocks = pool.GetBlocks();
  let blockBytes = 0;
  for (const block of blocks) blockBytes += block.GetSize();
  return { allocations: allocations.length, bytes, blocks: blocks.length, blockBytes };
}

/**
 * How many device resources the registry lists (geometries, textures, line sets, targets ever used).
 *
 * @returns {number} The count.
 */
export function RegisteredResourceCount()
{
  return TriDevice.GetResourcesRegistered().length;
}

/**
 * Frees a `Tr2RenderTarget` or `Tr2DepthStencil` for good: its device texture now, and its creation parameters, so
 * nothing rebuilds it. (`ReleaseResources(storage)` is the engine's residency call: with no argument it does nothing,
 * and with a storage mask it frees the texture but keeps the parameters, and the next use rebuilds it.)
 * `Create` on the same object makes it again.
 *
 * @param {object} target A `Tr2RenderTarget` or `Tr2DepthStencil`.
 */
export function ReleaseRenderTarget(target)
{
  if (!target) return;
  target.Destroy();
  TriDevice.UnregisterResource(target);
}
