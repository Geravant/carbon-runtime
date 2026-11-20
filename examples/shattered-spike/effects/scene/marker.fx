// Capability page: hundreds of small things in one draw. A unit quad drawn once per instance
// (Tr2InstancedMesh over a Tr2RuntimeInstanceData stream), turned to the camera in the vertex shader.
// Alpha blended over the scene; depth tested, not written.
//
// Instance elements arrive with their usage index raised by 8 (Tr2InstancedMesh):
// the stream's TEXCOORD0 is TEXCOORD8 here, TEXCOORD1 is TEXCOORD9.

#include "Scene.fxh"

struct MarkerVSInput
{
    float3 corner : POSITION;        // the quad: xy in -1..1
    float4 placement : TEXCOORD8;    // per instance: xyz world position, w half-size in world units
    float4 colour : TEXCOORD9;       // per instance: rgba
};

struct MarkerVSOutput
{
    float4 position : SV_Position;
    float2 corner : TEXCOORD0;
    float4 colour : TEXCOORD1;
};

MarkerVSOutput MarkerVS( MarkerVSInput input )
{
    MarkerVSOutput output;
    float3 world = input.placement.xyz
        + ( PerFrameVS.CameraRight.xyz * input.corner.x + PerFrameVS.CameraUp.xyz * input.corner.y ) * input.placement.w;
    output.position = mul( float4( world, 1.0 ), PerFrameVS.ViewProjectionMat );
    output.corner = input.corner.xy;
    output.colour = input.colour;
    return output;
}

float4 MarkerPS( MarkerVSOutput input ) : SV_Target
{
    float r = length( input.corner );
    float ring = smoothstep( 0.55, 0.65, r ) * ( 1.0 - smoothstep( 0.88, 0.98, r ) );
    float dot = 1.0 - smoothstep( 0.22, 0.32, r );
    return float4( input.colour.rgb, input.colour.a * saturate( ring + dot ) );
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
        SrcBlend = SRCALPHA;
        DestBlend = INVSRCALPHA;
        VertexShader = compile vs_5_0 MarkerVS();
        PixelShader = compile ps_5_0 MarkerPS();
    }
}
