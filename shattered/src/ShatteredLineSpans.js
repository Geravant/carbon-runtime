// A span per line of a Tr2CurveLineSet, changed every frame without resubmitting the set.
//
// The set writes, into every vertex, the line's id (TEXCOORD2.z) and how far along the line that vertex is
// (TEXCOORD1.y, 0 at the line's start to 1 at its end; for a curved line it is the curve parameter, even
// steps per segment). So the span lives in a small float texture the line effect reads by id, and the
// fragment stage drops what falls outside it. Changing a span is a 16-byte texture write; the vertex buffer
// is not touched. The shader half is a few lines (examples/shattered-spike/effects/req/LineSpan.fxh):
//
//   Texture2D LineSpans;
//   float2 LineSpan( float id ) { int i = int( id + 0.5 ); return LineSpans.Load( int3( i % 256, i / 256, 0 ) ).xy; }
//   // pixel shader: float2 span = LineSpan( lineId ); if( along < span.x || along > span.y ) discard;
import { CreateTextureFromData, UpdateTextureFromData, ReleaseTexture } from "./ShatteredTextures.js";

/** Texels across the span texture: line id `i` is texel (i % 256, i / 256). */
export const LINE_SPAN_ROW = 256;

export class CurveLineSpans
{
  /**
   * @param {object} [options] Options.
   * @param {number} [options.lines=256] Line ids the texture holds at first (it grows by whole rows of 256).
   */
  constructor({ lines = LINE_SPAN_ROW } = {})
  {
    this._rows = Math.max(1, Math.ceil(lines / LINE_SPAN_ROW));
    this._data = CurveLineSpans._Fresh(this._rows);
    this._texture = CreateTextureFromData(this._data, LINE_SPAN_ROW, this._rows, { format: "rgba32f", name: "line spans" });
    this._bound = [];
    this._dirtyLow = Infinity;
    this._dirtyHigh = -1;
  }

  static _Fresh(rows)
  {
    const data = new Float32Array(LINE_SPAN_ROW * rows * 4);
    for (let i = 0; i < data.length; i += 4) data[i + 1] = 1;   // every line whole: from 0 to 1
    return data;
  }

  /** The texture, for binding by hand. */
  GetTexture()
  {
    return this._texture;
  }

  /**
   * Binds the span texture to a line effect under `name` (the `Texture2D` in the .fx). Kept: a growth rebinds.
   *
   * @param {object} effect The line set's `Tr2Effect`.
   * @param {string} [name="LineSpans"] The texture's name in the effect.
   */
  Bind(effect, name = "LineSpans")
  {
    effect.SetParameter__TextureProvider(name, this._texture);
    this._bound.push([ effect, name ]);
  }

  /**
   * Draws only the part of line `id` from `start` to `end` (0..1 along it). `start > end` hides the line.
   *
   * @param {number} id The id `AddStraightLine` / `AddCurvedLineCrt` / ... returned.
   * @param {number} start From here.
   * @param {number} end To here.
   */
  Set(id, start, end)
  {
    if (!Number.isInteger(id) || id < 0) throw new RangeError(`CurveLineSpans.Set: ${id} is not a line id`);
    if (id >= this._rows * LINE_SPAN_ROW) this._Grow(Math.floor(id / LINE_SPAN_ROW) + 1);
    this._data[id * 4] = start;
    this._data[id * 4 + 1] = end;
    this._dirtyLow = Math.min(this._dirtyLow, id);
    this._dirtyHigh = Math.max(this._dirtyHigh, id);
  }

  /** @returns {number[]} [start, end] of line `id`. */
  Get(id)
  {
    return [ this._data[id * 4] ?? 0, this._data[id * 4 + 1] ?? 1 ];
  }

  /** Writes the spans changed since the last call to the texture (rows they touch only). Call once a frame before drawing. */
  Upload()
  {
    if (this._dirtyHigh < 0) return;
    const firstRow = Math.floor(this._dirtyLow / LINE_SPAN_ROW), lastRow = Math.floor(this._dirtyHigh / LINE_SPAN_ROW);
    UpdateTextureFromData(this._texture, this._data.subarray(firstRow * LINE_SPAN_ROW * 4, (lastRow + 1) * LINE_SPAN_ROW * 4),
      { x: 0, y: firstRow, width: LINE_SPAN_ROW, height: lastRow - firstRow + 1 });
    this._dirtyLow = Infinity;
    this._dirtyHigh = -1;
  }

  _Grow(rows)
  {
    const data = CurveLineSpans._Fresh(rows);
    data.set(this._data);
    const old = this._texture;
    this._data = data;
    this._rows = rows;
    this._texture = CreateTextureFromData(data, LINE_SPAN_ROW, rows, { format: "rgba32f", name: "line spans" });
    for (const [ effect, name ] of this._bound) effect.SetParameter__TextureProvider(name, this._texture);
    ReleaseTexture(old);
  }

  /** Frees the texture. */
  Release()
  {
    ReleaseTexture(this._texture);
    this._texture = null;
  }
}
