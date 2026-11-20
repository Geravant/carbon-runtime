// Request 1 proof, the problem: the same wash written opaquely (what the galaxy map does today). Where it lies over the
// territory or another wash it replaces both, strength included: a pale hole.
#include "Req.fxh"

float4 WashOpaquePS( FlatVSOutput input ) : SV_Target
{
    return input.colour;
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
        PixelShader = compile ps_5_0 WashOpaquePS();
    }
}
