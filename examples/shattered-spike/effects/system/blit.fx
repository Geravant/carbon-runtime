// Shattered Reach spike: our own file at the engine's built-in blit path
// (Tr2Blitter asks for res:/graphics/effect/managed/space/system/blit.fx at
// start-up): the source texture copied to the target, point sampled.
// The source arrives through the global variable BlitSource.

Texture2D BlitSource;

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
    uint width;
    uint height;
    BlitSource.GetDimensions( width, height );
    int2 size = int2( width, height );
    return BlitSource.Load( int3( clamp( int2( input.texCoord * float2( size ) ), int2( 0, 0 ), size - 1 ), 0 ) );
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
