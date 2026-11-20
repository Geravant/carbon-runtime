// An instance stream whose device allocation has a capacity: rows may grow and shrink every frame without the
// stream giving its slice of the shared buffer back and taking a new one.
//
// Tr2RuntimeInstanceData frees its allocation whenever SetData changes the row count, and the next UpdateData
// allocates exactly `count` rows again. InstanceStream allocates whole powers of two (at least `minCapacity`
// rows) and keeps the allocation while the rows fit; only the rows given are uploaded, and the draw uses the
// row count, so no padding rows are needed. Everything else is Tr2RuntimeInstanceData's: SetElementLayout,
// SetData, UpdateData, and it is the instance provider of a Tr2InstancedMesh as before.
import { Tr2RuntimeInstanceData } from "../../src/trinity/core/mesh/Tr2RuntimeInstanceData.js";
import { SharedGeometryBuffer } from "../../src/trinity/core/mesh/TriGeometryResAllocations.js";
import { Tr2RenderContext_GetMainThreadRenderContext } from "../../src/trinity/core/context/Tr2RenderContext.js";

export class InstanceStream extends Tr2RuntimeInstanceData
{
  /**
   * @param {object} [options] Options.
   * @param {number} [options.minCapacity=64] The smallest allocation, in rows.
   */
  constructor({ minCapacity = 64 } = {})
  {
    super();
    this.minCapacity = Math.max(1, minCapacity | 0);
    this._keepAllocation = false;
    /** How many times the device allocation was made (for a test that it is kept). */
    this.allocations = 0;
  }

  /** Rows the current allocation holds (0 before the first UpdateData). */
  GetCapacity()
  {
    return this._allocation?.IsValid() && this._stride ? this._allocation._size / this._stride : 0;
  }

  _setData(rows)
  {
    this._keepAllocation = Array.isArray(rows) && rows.length > 0 && rows.length <= this.GetCapacity();
    try
    {
      super._setData(rows);
    }
    finally
    {
      this._keepAllocation = false;
    }
  }

  _freeAllocation()
  {
    if (this._keepAllocation) return;
    super._freeAllocation();
  }

  _OnPrepareResources()
  {
    if (this._data && this._stride && this.count && (!this._allocation || !this._allocation.IsValid()))
    {
      const capacity = Math.max(this.minCapacity, 2 ** Math.ceil(Math.log2(this.count)));
      const bytes = new Uint8Array(capacity * this._stride);
      bytes.set(this._bytes);
      const context = Tr2RenderContext_GetMainThreadRenderContext();
      this._allocation = SharedGeometryBuffer(context).Allocate(this._stride, capacity, bytes, context);
      if (!this._allocation) return false;
      this.allocations++;
    }
    return super._OnPrepareResources();
  }
}
