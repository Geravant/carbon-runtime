// Request 3 proof: Tr2CurveLineSet lines clipped to a span of their length, per line, with no resubmit.
// The set's vertex layout (Tr2CurveLineSet.WriteLineVerticesToBuffer, as in ../scene/line.fx); positions are clip
// space here, widths clip units.
#include "LineSpan.fxh"

struct LineVSInput
{
    float3 position : POSITION;
    float4 direction : TEXCOORD0;   // xyz to the other end, w the half width with the side's sign
    float4 along : TEXCOORD1;       // x 0 at the segment's start and 1 at its end, y 0..1 along the whole line
    float3 animation : TEXCOORD2;   // z the line id
    float3 neighbour : TEXCOORD3;
    float4 colour : COLOR0;
};

struct LineVSOutput
{
    float4 position : SV_Position;
    float4 colour : TEXCOORD0;
    float2 lineAt : TEXCOORD1;        // x along the line, y the line id
};

LineVSOutput SpanLineVS( LineVSInput input )
{
    LineVSOutput output;
    float2 dir = normalize( input.direction.xy + float2( 0.00001, 0.0 ) ) * ( 1.0 - 2.0 * input.along.x );
    float2 side = float2( -dir.y, dir.x );
    output.position = float4( input.position.xy + side * input.direction.w, 0.5, 1.0 );
    output.colour = input.colour;
    output.lineAt = float2( input.along.y, input.animation.z );
    return output;
}

float4 SpanLinePS( LineVSOutput input ) : SV_Target
{
    float2 span = LineSpan( input.lineAt.y );
    if( input.lineAt.x < span.x || input.lineAt.x > span.y )
    {
        discard;
    }
    return float4( input.colour.rgb, 1.0 );
}

technique Main
{
    pass P0
    {
        ZEnable = false;
        ZWriteEnable = false;
        CullMode = NONE;
        AlphaBlendEnable = false;
        VertexShader = compile vs_5_0 SpanLineVS();
        PixelShader = compile ps_5_0 SpanLinePS();
    }
}
