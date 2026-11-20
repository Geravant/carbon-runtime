// M3 request 5 proof: one small square per instance row of an InstanceStream; opaque.
// Instance elements arrive with their usage index raised by 8: the stream's TEXCOORD0 is TEXCOORD8.
struct InstVSInput
{
    float3 corner : POSITION;      // the quad, -1..1
    float4 placement : TEXCOORD8;  // per instance: clip-space x, y, half size
};

struct InstVSOutput
{
    float4 position : SV_Position;
};

InstVSOutput InstVS( InstVSInput input )
{
    InstVSOutput output;
    output.position = float4( input.placement.xy + input.corner.xy * input.placement.z, 0.5, 1.0 );
    return output;
}

float4 InstPS( InstVSOutput input ) : SV_Target
{
    return float4( 0.1, 0.1, 0.1, 1.0 );
}

technique Main
{
    pass P0
    {
        ZEnable = false;
        ZWriteEnable = false;
        CullMode = NONE;
        AlphaBlendEnable = false;
        VertexShader = compile vs_5_0 InstVS();
        PixelShader = compile ps_5_0 InstPS();
    }
}
