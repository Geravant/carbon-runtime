// Request 1 proof: the full-screen paper pass. It reads the scene's colour target (what the opaque AND the transparent
// passes left there) and lays the pigment into the paper by the strength in alpha.
Texture2D SceneColour;

struct PaperVSInput
{
    float4 position : POSITION;
    float2 texCoord : TEXCOORD0;
};

struct PaperVSOutput
{
    float4 position : SV_Position;
    float2 texCoord : TEXCOORD0;
};

PaperVSOutput PaperVS( PaperVSInput input )
{
    PaperVSOutput output;
    output.position = input.position;
    output.texCoord = input.texCoord;
    return output;
}

float4 PaperPS( PaperVSOutput input ) : SV_Target
{
    uint width;
    uint height;
    SceneColour.GetDimensions( width, height );
    int2 size = int2( width, height );
    float4 scene = SceneColour.Load( int3( clamp( int2( input.texCoord * float2( size ) ), int2( 0, 0 ), size - 1 ), 0 ) );
    float3 paper = float3( 0.95, 0.92, 0.85 );
    return float4( lerp( paper, scene.rgb, saturate( scene.a ) ), 1.0 );
}

technique Main
{
    pass P0
    {
        ZEnable = false;
        ZWriteEnable = false;
        CullMode = NONE;
        AlphaBlendEnable = false;
        VertexShader = compile vs_5_0 PaperVS();
        PixelShader = compile ps_5_0 PaperPS();
    }
}
