// The shader half of CurveLineSpans (shattered/src/ShatteredLineSpans.js): a span per line of a Tr2CurveLineSet,
// read by the line's id from a float texture. Line id i is texel (i % 256, i / 256); x the start, y the end, 0..1
// along the line. Drop the fragment when the vertex's "along" value falls outside.
#ifndef LINE_SPAN_FXH
#define LINE_SPAN_FXH

Texture2D LineSpans;

float2 LineSpan( float id )
{
    int i = int( id + 0.5 );
    return LineSpans.Load( int3( i % 256, i / 256, 0 ) ).xy;
}

#endif
