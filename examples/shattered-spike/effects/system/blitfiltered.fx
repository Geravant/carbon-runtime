// Shattered Reach spike: our own file at the engine's built-in blit path
// (Tr2Blitter asks for res:/graphics/effect/managed/space/system/blitfiltered.fx at
// start-up): the source texture copied to the target, linearly filtered.
// The source arrives through the global variable BlitSource.

Texture2D BlitSource;
SamplerState BlitSampler
{
    Filter = MIN_MAG_MIP_LINEAR;
    AddressU = CLAMP;
    AddressV = CLAMP;
};

struct BlitVSInput
{
    float4 position : POSITION;
    float2 texCoord : TEXCOORD0;
};

struct BlitVSOutput
{
    float4 position : SV_Position;
    float2 texCoord : TEXCOORD0;
};

BlitVSOutput BlitVS( BlitVSInput input )
{
    BlitVSOutput output;
    output.position = input.position;
    output.texCoord = input.texCoord;
    return output;
}

float4 BlitPS( BlitVSOutput input ) : SV_Target
{
    return BlitSource.Sample( BlitSampler, input.texCoord );
}

technique Main
{
    pass P0
    {
        ZEnable = false;
        ZWriteEnable = false;
        CullMode = NONE;
        AlphaBlendEnable = false;
        VertexShader = compile vs_5_0 BlitVS();
        PixelShader = compile ps_5_0 BlitPS();
    }
}
