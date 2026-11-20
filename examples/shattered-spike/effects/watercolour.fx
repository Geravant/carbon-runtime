// Shattered Reach spike: the full-screen watercolour pass. One quad over the
// scene's colour and normal targets, written to the canvas.
//
// Ported essentials of the game's painter:
//  - the ink (src/ship-models.js FS_COMP): silhouette, creases (normal change)
//    and depth steps, a line a set number of pixels wide whose width wobbles;
//  - the paper (src/watercolour.js FS): ivory, grain, fibre and a vignette;
//  - the wash (src/watercolour.js wash()): pigment multiplied into the paper,
//    here a cool pooled wash round each hull, and a faint halo under the ink;
//  - edge darkening: pigment pooled just inside the hull's outline.

// The scene's colour: rgb the body wash, a 1 on a hull.
Texture2D SceneColour;
// The scene's view normal (rgb, packed) and depth (a).
Texture2D SceneNormal;

float4 InkColour
<
    bool SasUiVisible = true;
    string Group = "Watercolour";
    string SasUiDescription = "The ink line's colour";
    string UIWidget = "LinearColor";
> = float4( 0.118, 0.11, 0.18, 1.0 );

float4 InkSettings
<
    bool SasUiVisible = true;
    string Group = "Watercolour";
    string SasUiDescription = "( Line width in pixels, Crease strength, Wash strength, Edge darkening )";
    string UIWidget = "VectorMixed";
    string Component1 = "Line width in pixels";
    string Component2 = "Crease strength";
    string Component3 = "Wash strength";
    string Component4 = "Edge darkening";
> = float4( 1.6, 1.0, 1.0, 1.0 );

float4 PaperColour
<
    bool SasUiVisible = true;
    string Group = "Watercolour";
    string SasUiDescription = "The paper";
    string UIWidget = "LinearColor";
> = float4( 0.958, 0.938, 0.897, 1.0 );

struct WatercolourVSInput
{
    float4 position : POSITION;
    float2 texCoord : TEXCOORD0;
};

float4 WatercolourVS( WatercolourVSInput input ) : SV_Position
{
    return input.position;
}

float hash2( float2 p )
{
    p = frac( p * float2( 123.34, 456.21 ) );
    p += dot( p, p + 45.32 );
    return frac( p.x * p.y );
}

float noise2( float2 p )
{
    float2 i = floor( p );
    float2 f = frac( p );
    float2 u = f * f * ( 3.0 - 2.0 * f );
    return lerp( lerp( hash2( i ), hash2( i + float2( 1.0, 0.0 ) ), u.x ), lerp( hash2( i + float2( 0.0, 1.0 ) ), hash2( i + float2( 1.0, 1.0 ) ), u.x ), u.y );
}

float fbm2( float2 p )
{
    float v = 0.0;
    float a = 0.5;
    for( int i = 0; i < 4; ++i )
    {
        v += a * noise2( p );
        p *= 2.03;
        a *= 0.5;
    }
    return v;
}

float3 wash( float3 col, float3 pig, float a )
{
    return col * lerp( float3( 1.0, 1.0, 1.0 ), pig, saturate( a ) );
}

float4 ColourAt( int2 pixel, int2 size )
{
    return SceneColour.Load( int3( clamp( pixel, int2( 0, 0 ), size - 1 ), 0 ) );
}

float4 NormalAt( int2 pixel, int2 size )
{
    return SceneNormal.Load( int3( clamp( pixel, int2( 0, 0 ), size - 1 ), 0 ) );
}

// How much of an edge lies between a pixel and its neighbour at an offset.
float EdgeAt( int2 pixel, float2 offset, int2 size, float4 c, float4 n )
{
    int2 q = pixel + int2( round( offset ) );
    float4 c2 = ColourAt( q, size );
    float4 n2 = NormalAt( q, size );
    float here = c.a > 0.01 ? 1.0 : 0.0;
    float there = c2.a > 0.01 ? 1.0 : 0.0;
    float e = abs( here - there );
    if( here > 0.5 && there > 0.5 )
    {
        e = max( e, InkSettings.y * 0.75 * smoothstep( 0.35, 0.6, length( n.rgb - n2.rgb ) ) );
        e = max( e, InkSettings.y * smoothstep( 0.006, 0.014, abs( n.a - n2.a ) ) );
    }
    return e;
}

// The share of hull among eight pixels on a ring.
float Coverage( int2 pixel, float radius, int2 size )
{
    float sum = 0.0;
    for( int i = 0; i < 8; ++i )
    {
        float angle = 0.7853982 * float( i );
        sum += ColourAt( pixel + int2( round( float2( cos( angle ), sin( angle ) ) * radius ) ), size ).a > 0.01 ? 1.0 : 0.0;
    }
    return sum * 0.125;
}

float4 WatercolourPS( float4 position : SV_Position ) : SV_Target
{
    uint width;
    uint height;
    SceneColour.GetDimensions( width, height );
    int2 size = int2( width, height );
    int2 pixel = int2( position.xy );
    float2 uv = position.xy / float2( size );
    float2 p = float2( uv.x * float( width ) / float( height ), uv.y );

    // The paper.
    float grain = noise2( p * 420.0 ) * 0.5 + noise2( p * 170.0 ) * 0.5;
    float fiber = noise2( p * float2( 34.0, 7.0 ) );
    float3 col = PaperColour.rgb - ( grain - 0.5 ) * 0.05 - ( fiber - 0.5 ) * 0.04;
    float2 centred = uv - 0.5;
    col *= 1.0 - dot( centred, centred ) * 0.20;

    float4 c = ColourAt( pixel, size );
    float4 n = NormalAt( pixel, size );

    // The wash: a cool pool round each hull, its edge wandering with the paper.
    float wander = ( fbm2( p * 9.0 + 3.0 ) - 0.5 ) * 0.5;
    float near = Coverage( pixel, 10.0, size ) * 0.6 + Coverage( pixel, 26.0, size ) * 0.4;
    float pool = smoothstep( 0.05, 0.6, near + wander * 0.4 );
    float rim = smoothstep( 0.02, 0.12, near + wander * 0.2 ) - smoothstep( 0.12, 0.35, near + wander * 0.2 );
    col = wash( col, float3( 0.70, 0.74, 0.86 ), InkSettings.z * pool * ( 0.22 + 0.16 * fbm2( p * 4.0 ) ) );
    col = wash( col, float3( 0.62, 0.64, 0.74 ), InkSettings.z * rim * 0.30 );

    // The ink.
    float w = InkSettings.x * ( 0.8 + 0.5 * noise2( position.xy * 0.08 ) );
    float e = 0.0;
    e = max( e, EdgeAt( pixel, float2( w, 0.0 ), size, c, n ) );
    e = max( e, EdgeAt( pixel, float2( -w, 0.0 ), size, c, n ) );
    e = max( e, EdgeAt( pixel, float2( 0.0, w ), size, c, n ) );
    e = max( e, EdgeAt( pixel, float2( 0.0, -w ), size, c, n ) );
    e = max( e, 0.7 * EdgeAt( pixel, float2( w, w ) * 0.7, size, c, n ) );
    e = max( e, 0.7 * EdgeAt( pixel, float2( -w, -w ) * 0.7, size, c, n ) );

    if( c.a > 0.01 )
    {
        // Edge darkening: pigment pools just inside the outline.
        float inside = Coverage( pixel, 4.0, size );
        float3 body = c.rgb * ( 0.94 + 0.12 * noise2( p * 300.0 ) );
        body *= 1.0 - InkSettings.w * 0.28 * ( 1.0 - smoothstep( 0.5, 1.0, inside ) );
        col = lerp( body, InkColour.rgb, e * 0.92 );
    }
    else
    {
        // A faint halo under the line, then the line.
        col *= 1.0 - Coverage( pixel, 3.0, size ) * 0.12;
        col = lerp( col, InkColour.rgb * ( 0.92 + 0.16 * noise2( p * 300.0 ) ), e * 0.93 );
    }
    return float4( col, 1.0 );
}

technique Main
{
    pass P0
    {
        ZEnable = false;
        ZWriteEnable = false;
        CullMode = NONE;
        AlphaBlendEnable = false;
        VertexShader = compile vs_5_0 WatercolourVS();
        PixelShader = compile ps_5_0 WatercolourPS();
    }
}
