// Shattered Reach spike: the hull's body wash (the game's FS_BODY in
// src/ship-models.js), drawn into the colour target; alpha 1 marks the hull.
// Not ported: damage (burn, ember, breach), and the rib, light, patch and
// stripe seam styles; plates are.

#include "Hull.fxh"

// One plating seam line about a pixel wide, let go where lines would crowd.
float seamLine( float v )
{
    float d = fwidth( v );
    float t = ( 0.5 - abs( frac( v ) - 0.5 ) ) / max( d, 0.0001 );
    return ( 1.0 - smoothstep( 0.6, 1.6, t ) ) * ( 1.0 - smoothstep( 0.12, 0.3, d ) );
}

float4 HullPS( HullVSOutput input ) : SV_Target
{
    float kind = input.kindSeam.x;
    float3 local = input.local;
    float3 N = normalize( input.viewNormal );
    if( N.z < 0.0 )
    {
        N = -N;
    }

    // Seams first: the derivatives are taken before any branch.
    float3 a = abs( normalize( input.localNormal ) );
    float2 uv = ( a.y > a.z && a.y > a.x * 0.8 ? local.xz : ( a.z > a.x * 0.8 ? local.xy : local.zy ) ) * input.kindSeam.z;
    uv.x *= 0.5;
    uv.x += floor( uv.y ) * 0.5;
    float seam = max( seamLine( uv.x ), seamLine( uv.y ) * 0.8 );
    float plate = h3( float3( floor( uv ), 1.0 ) ) * 2.0 - 1.0;
    if( input.kindSeam.y < 0.5 )
    {
        seam = 0.0;
        plate = 0.0;
    }

    float3 col;
    if( kind > 2.5 )
    {
        col = float3( 0.1, 0.09, 0.12 );
    }
    else if( kind > 1.5 )
    {
        col = lerp( float3( 0.22, 0.17, 0.16 ), input.colour * 1.15, PerFramePS.Paint.x );
    }
    else if( kind > 0.5 )
    {
        col = input.colour;
    }
    else
    {
        float ndl = dot( N, PerFramePS.LightDirection.xyz ) * 0.5 + 0.5;
        float lit = bands( ndl + ( fbm3( local * 1.7 + 7.0 ) - 0.5 ) * 0.22 );
        float dens = lerp( 1.12, 0.6, lit );
        dens *= 1.0 - 0.55 * smoothstep( 0.86, 0.97, ndl + ( n3( local * 9.0 ) - 0.5 ) * 0.12 );
        dens *= 0.78 + 0.44 * fbm3( local * 2.6 );
        dens += ( n3( local * 36.0 ) - 0.5 ) * 0.24 + ( n3( local * 11.0 ) - 0.5 ) * 0.12;
        dens += pow( 1.0 - abs( N.z ), 2.5 ) * 0.3;
        dens *= 1.0 + plate * 0.08;
        dens += seam * 0.32;
        float3 pig = input.colour * lerp( float3( 0.62, 0.64, 0.86 ), float3( 1.0, 1.0, 1.0 ), lit );
        col = lerp( PerFramePS.Paper.rgb, pig, saturate( dens * PerFramePS.Paint.y ) );
    }
    return float4( col, 1.0 );
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
