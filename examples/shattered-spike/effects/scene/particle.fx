// Capability page: the engine's CPU particle system (Tr2ParticleSystem, fed by a Tr2DynamicEmitter)
// drawn with our own effect. The system is the instance stream of a Tr2InstancedMesh over a unit quad.
// Its elements arrive as: POSITION -> POSITION8 (this frame) and POSITION9 (the frame before),
// LIFETIME -> TANGENT8 (x age 0..1, y lifetime in seconds), VELOCITY -> NORMAL8.
// Additive; depth tested, not written.

#include "Scene.fxh"

float4 ParticleColourYoung = float4( 1.0, 0.82, 0.45, 1.0 );
float4 ParticleColourOld = float4( 0.75, 0.16, 0.10, 1.0 );
float4 ParticleSize = float4( 0.05, 0.22, 0.0, 0.0 );   // x size when born, y size when it dies (world units)

struct ParticleVSInput
{
    float3 corner : POSITION;
    float3 centre : POSITION8;
    float2 life : TANGENT8;
    float3 velocity : NORMAL8;
};

struct ParticleVSOutput
{
    float4 position : SV_Position;
    float2 corner : TEXCOORD0;
    float2 life : TEXCOORD1;
};

ParticleVSOutput ParticleVS( ParticleVSInput input )
{
    ParticleVSOutput output;
    float size = lerp( ParticleSize.x, ParticleSize.y, input.life.x );
    float3 world = input.centre + ( PerFrameVS.CameraRight.xyz * input.corner.x + PerFrameVS.CameraUp.xyz * input.corner.y ) * size;
    output.position = mul( float4( world, 1.0 ), PerFrameVS.ViewProjectionMat );
    output.corner = input.corner.xy;
    output.life = float2( input.life.x, length( input.velocity ) );
    return output;
}

float4 ParticlePS( ParticleVSOutput input ) : SV_Target
{
    float soft = 1.0 - smoothstep( 0.0, 1.0, length( input.corner ) );
    float fade = ( 1.0 - input.life.x ) * smoothstep( 0.0, 0.08, input.life.x );
    float3 colour = lerp( ParticleColourYoung.rgb, ParticleColourOld.rgb, input.life.x );
    // Additive: premultiply by the fade, alpha unused.
    return float4( colour * soft * fade, 1.0 );
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
        VertexShader = compile vs_5_0 ParticleVS();
        PixelShader = compile ps_5_0 ParticlePS();
    }
}
