// Capability page: a sphere with our own shader. A textured, banded-light planet; opaque, depth written.

#include "Scene.fxh"

Texture2D PlanetMap;
SamplerState PlanetSampler
{
    Filter = MIN_MAG_MIP_LINEAR;
    AddressU = WRAP;
    AddressV = CLAMP;
};

float4 PlanetTint = float4( 1.0, 1.0, 1.0, 1.0 );

struct PlanetVSInput
{
    float3 position : POSITION;
    float3 normal : NORMAL;
    float2 texCoord : TEXCOORD0;
};

struct PlanetVSOutput
{
    float4 position : SV_Position;
    float3 normal : TEXCOORD0;
    float2 texCoord : TEXCOORD1;
};

PlanetVSOutput PlanetVS( PlanetVSInput input )
{
    PlanetVSOutput output;
    float4 world = mul( float4( input.position, 1.0 ), PerObjectVS.worldTransform );
    output.position = mul( world, PerFrameVS.ViewProjectionMat );
    output.normal = mul( float4( input.normal, 0.0 ), PerObjectVS.worldTransform ).xyz;
    output.texCoord = input.texCoord;
    return output;
}

float4 PlanetPS( PlanetVSOutput input ) : SV_Target
{
    float4 albedo = PlanetMap.Sample( PlanetSampler, input.texCoord );
    float ndl = dot( normalize( input.normal ), PerFramePS.LightDirection.xyz ) * 0.5 + 0.5;
    float lit = smoothstep( 0.30, 0.36, ndl ) * 0.55 + smoothstep( 0.62, 0.68, ndl ) * 0.45;
    return float4( albedo.rgb * PlanetTint.rgb * lerp( 0.28, 1.0, lit ), 1.0 );
}

technique Main
{
    pass P0
    {
        ZEnable = true;
        ZWriteEnable = true;
        ZFunc = LESSEQUAL;
        CullMode = NONE;
        AlphaBlendEnable = false;
        VertexShader = compile vs_5_0 PlanetVS();
        PixelShader = compile ps_5_0 PlanetPS();
    }
}
