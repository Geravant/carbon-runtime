// Requests 2, 5, 6 proof: a texture shown texel for texel (Load), as (texel - offset) * scale, opaque.
// Per vertex: xy the texel coordinate (0..1 across the texture), z the offset, w the scale.
#include "Req.fxh"

Texture2D Shown;

float4 ShowPS( FlatVSOutput input ) : SV_Target
{
    uint width;
    uint height;
    Shown.GetDimensions( width, height );
    int2 size = int2( width, height );
    float4 texel = Shown.Load( int3( clamp( int2( input.colour.xy * float2( size ) ), int2( 0, 0 ), size - 1 ), 0 ) );
    return float4( saturate( ( texel.rgb - input.colour.z ) * input.colour.w ), 1.0 );
}

technique Main
{
    pass P0
    {
        ZEnable = false;
        ZWriteEnable = false;
        CullMode = NONE;
        AlphaBlendEnable = false;
        VertexShader = compile vs_5_0 FlatVS();
        PixelShader = compile ps_5_0 ShowPS();
    }
}
