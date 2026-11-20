// Request 1 proof: a wash laid INTO the scene's colour target, in the transparent pass, blended.
// Colour: pigment over what is there, by the wash's strength (SRCALPHA / INVSRCALPHA).
// Alpha: strength over strength, a + d (1 - a) (ONE / INVSRCALPHA, a separate alpha blend), so two washes, or a wash
// over the territory, make a stronger stroke for the paper pass, never a paler one.
#include "Req.fxh"

float4 WashPS( FlatVSOutput input ) : SV_Target
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
        AlphaBlendEnable = true;
        SrcBlend = SRCALPHA;
        DestBlend = INVSRCALPHA;
        BlendOp = ADD;
        SeparateAlphaBlendEnable = true;
        SrcBlendAlpha = ONE;
        DestBlendAlpha = INVSRCALPHA;
        BlendOpAlpha = ADD;
        VertexShader = compile vs_5_0 FlatVS();
        PixelShader = compile ps_5_0 WashPS();
    }
}
