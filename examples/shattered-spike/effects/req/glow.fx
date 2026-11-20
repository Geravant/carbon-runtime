// M3 request 4 proof: an additive stroke (ONE / ONE), drawn by a TriStepRenderObject's additive pass just before the
// full-screen paper pass, whose own pass says AlphaBlendEnable = false.
#include "Req.fxh"

float4 GlowPS( FlatVSOutput input ) : SV_Target
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
        SrcBlend = ONE;
        DestBlend = ONE;
        VertexShader = compile vs_5_0 FlatVS();
        PixelShader = compile ps_5_0 GlowPS();
    }
}
