// Shattered Reach spike: the hull's wash and its view normal and depth written in ONE pass to two
// colour targets (multiple render targets): what hull.fx and hullnormal.fx write in two passes.
// Target 0: rgb the wash, a 1 on a hull. Target 1: rgb the packed view normal, a depth.

#include "HullWash.fxh"

struct HullTargets
{
    float4 colour : SV_Target0;
    float4 normal : SV_Target1;
};

HullTargets HullMrtPS( HullVSOutput input )
{
    HullTargets output;
    output.colour = HullWash( input );
    float3 N = normalize( input.viewNormal );
    if( N.z < 0.0 )
    {
        N = -N;
    }
    output.normal = float4( N * 0.5 + 0.5, input.position.z );
    return output;
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
        PixelShader = compile ps_5_0 HullMrtPS();
    }
}
