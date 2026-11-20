// Shattered Reach spike: the hull's view normal and depth (the game's FS_NRM),
// drawn into the normal target as an override material over the same batches;
// the ink pass finds creases and depth steps in it.

#include "Hull.fxh"

float4 HullNormalPS( HullVSOutput input ) : SV_Target
{
    float3 N = normalize( input.viewNormal );
    if( N.z < 0.0 )
    {
        N = -N;
    }
    return float4( N * 0.5 + 0.5, input.position.z );
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
        VertexShader = compile vs_5_0 HullVS();
        PixelShader = compile ps_5_0 HullNormalPS();
    }
}
