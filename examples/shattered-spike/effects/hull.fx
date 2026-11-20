// Shattered Reach spike: the hull's body wash (the game's FS_BODY in
// src/ship-models.js), drawn into the colour target; alpha 1 marks the hull.
// Not ported: damage (burn, ember, breach), and the rib, light, patch and
// stripe seam styles; plates are.

#include "HullWash.fxh"

float4 HullPS( HullVSOutput input ) : SV_Target
{
    return HullWash( input );
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
        PixelShader = compile ps_5_0 HullPS();
    }
}
