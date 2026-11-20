// Shattered Reach spike: the hull's vertex stage and the painter's shared
// noise, ported from the game's src/ship-models.js (VS, NOISE, SHADE).
//
// A vertex is what examples/shattered-spike/tools/export-hull.mjs writes:
// position, normal, colour (the part's pigment), kind (0 hull, 1 light,
// 2 engine glow, 3 dark) and seam (style, lines per ship unit).

#ifndef HULL_FXH
#define HULL_FXH

#include "ShatteredFrame.fxh"

struct HullVSInput
{
    float3 position : POSITION;
    float3 normal : NORMAL;
    float3 colour : COLOR0;
    float kind : TEXCOORD0;
    float2 seam : TEXCOORD1;
};

struct HullVSOutput
{
    float4 position : SV_Position;
    float3 viewNormal : TEXCOORD0;
    float3 local : TEXCOORD1;
    float3 colour : TEXCOORD2;
    float3 localNormal : TEXCOORD3;
    float3 kindSeam : TEXCOORD4;
};

HullVSOutput HullVS( HullVSInput input )
{
    HullVSOutput output;
    float4 world = mul( float4( input.position, 1.0 ), PerObjectVS.worldTransform );
    output.position = mul( world, PerFrameVS.ViewProjectionMat );
    float3 worldNormal = mul( float4( input.normal, 0.0 ), PerObjectVS.worldTransform ).xyz;
    output.viewNormal = mul( float4( worldNormal, 0.0 ), PerFrameVS.ViewMat ).xyz;
    output.local = input.position;
    output.colour = input.colour;
    output.localNormal = input.normal;
    output.kindSeam = float3( input.kind, input.seam );
    return output;
}

float h3( float3 p )
{
    p = frac( p * float3( 0.1031, 0.1030, 0.0973 ) );
    p += dot( p, p.yxz + 33.33 );
    return frac( ( p.x + p.y ) * p.z );
}

float n3( float3 p )
{
    float3 i = floor( p );
    float3 f = frac( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return lerp(
        lerp( lerp( h3( i ), h3( i + float3( 1, 0, 0 ) ), f.x ), lerp( h3( i + float3( 0, 1, 0 ) ), h3( i + float3( 1, 1, 0 ) ), f.x ), f.y ),
        lerp( lerp( h3( i + float3( 0, 0, 1 ) ), h3( i + float3( 1, 0, 1 ) ), f.x ), lerp( h3( i + float3( 0, 1, 1 ) ), h3( i + float3( 1, 1, 1 ) ), f.x ), f.y ),
        f.z );
}

float fbm3( float3 p )
{
    float v = 0.0;
    float a = 0.5;
    for( int i = 0; i < 4; ++i )
    {
        v += a * n3( p );
        p *= 2.03;
        a *= 0.5;
    }
    return v;
}

// The two steps of the wash: shadow, half-tone, light.
float bands( float ndl )
{
    return smoothstep( 0.36, 0.44, ndl ) * 0.5 + smoothstep( 0.64, 0.72, ndl ) * 0.5;
}

#endif // HULL_FXH
