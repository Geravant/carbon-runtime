// Request 1 proof: the field under everything, written opaquely, its strength in alpha (as the galaxy map's territory is).
#include "Req.fxh"

float4 TerritoryPS( FlatVSOutput input ) : SV_Target
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
        PixelShader = compile ps_5_0 TerritoryPS();
    }
}
