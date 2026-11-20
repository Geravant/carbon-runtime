// Capability page: lines and curves from the engine's Tr2CurveLineSet with our own effect.
// The set writes six vertices a segment (two triangles) in this layout (Tr2CurveLineSet.js,
// WriteLineVerticesToBuffer); the vertex shader widens the segment in screen space.
// Additive; depth tested, not written.

#include "Scene.fxh"

struct LineVSInput
{
    float3 position : POSITION;     // this end of the segment
    float4 direction : TEXCOORD0;   // xyz to the other end, w the half width with the side's sign (pixels here)
    float4 along : TEXCOORD1;       // x 0 at the segment's start and 1 at its end, y length along the line 0..1
    float3 animation : TEXCOORD2;   // x speed, y scale, z line id
    float3 neighbour : TEXCOORD3;   // the point before the start, or after the end
    float4 colour : COLOR0;
};

struct LineVSOutput
{
    float4 position : SV_Position;
    float4 colour : TEXCOORD0;
    float2 across : TEXCOORD1;      // x -1..1 across the line, y 0..1 along it
};

LineVSOutput LineVS( LineVSInput input )
{
    LineVSOutput output;
    float4 here = mul( float4( input.position, 1.0 ), PerFrameVS.ViewProjectionMat );
    float4 there = mul( float4( input.position + input.direction.xyz, 1.0 ), PerFrameVS.ViewProjectionMat );
    // The segment's direction on screen, always from its start to its end.
    float2 screen = ( there.xy / max( there.w, 0.0001 ) - here.xy / max( here.w, 0.0001 ) ) * PerFrameVS.Viewport.xy;
    screen *= 1.0 - 2.0 * input.along.x;
    float2 side = normalize( float2( -screen.y, screen.x ) + float2( 0.00001, 0.0 ) );
    here.xy += side * input.direction.w / PerFrameVS.Viewport.xy * 2.0 * here.w;
    output.position = here;
    output.colour = input.colour;
    output.across = float2( sign( input.direction.w ), input.along.y );
    return output;
}

float4 LinePS( LineVSOutput input ) : SV_Target
{
    float core = 1.0 - smoothstep( 0.25, 1.0, abs( input.across.x ) );
    // A dash pattern running along the line.
    float dash = 0.65 + 0.35 * step( 0.5, frac( input.across.y * 24.0 - PerFramePS.Time.x * 0.8 ) );
    return float4( input.colour.rgb * core * dash * input.colour.a, 1.0 );
}

technique Main
{
    pass P0
    {
        ZEnable = true;
        ZWriteEnable = false;
        ZFunc = LESSEQUAL;
        CullMode = NONE;
        AlphaBlendEnable = true;
        SrcBlend = ONE;
        DestBlend = ONE;
        VertexShader = compile vs_5_0 LineVS();
        PixelShader = compile ps_5_0 LinePS();
    }
}
