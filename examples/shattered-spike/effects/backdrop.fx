// Shattered Reach spike: a textured full-screen quad drawn to the canvas before the watercolour
// pass (the picture behind the ship), reading three textures of our own through samplers:
//  - BackdropMap: a JPEG loaded from a URL (LoadTexture), linear or point filtered;
//  - MarkerMap: a PNG with alpha loaded through resMan (res:/textures/marker.png), tiled with a wrap sampler;
//  - CanvasMap: a 2D canvas drawn by the page and uploaded (CreateTextureFromImage / UpdateTextureFromImage).

Texture2D BackdropMap;
// The same texture bound under a second name for the point-sampled read. On WebGL2 a texture and its
// sampler are one GLSL sampler2D, so the compiler keeps ONE sampler state per texture name in an effect
// (the first one used); two states on one texture need two names. WebGPU honours each pair as written.
Texture2D BackdropPointMap;
Texture2D MarkerMap;
Texture2D CanvasMap;

SamplerState LinearClamp
{
    Filter = MIN_MAG_MIP_LINEAR;
    AddressU = CLAMP;
    AddressV = CLAMP;
};

SamplerState PointClamp
{
    Filter = MIN_MAG_MIP_POINT;
    AddressU = CLAMP;
    AddressV = CLAMP;
};

SamplerState LinearWrap
{
    Filter = MIN_MAG_MIP_LINEAR;
    AddressU = WRAP;
    AddressV = WRAP;
};

float4 BackdropTransform
<
    string SasUiDescription = "( u scale, v scale, u offset, v offset ) of the backdrop";
> = float4( 1.0, 1.0, 0.0, 0.0 );

float4 BackdropSettings
<
    string SasUiDescription = "( 1 = point sampling, insets 0..1, unused, unused )";
> = float4( 0.0, 1.0, 0.0, 0.0 );

struct BackdropVSInput
{
    float4 position : POSITION;
    float2 texCoord : TEXCOORD0;
};

struct BackdropVSOutput
{
    float4 position : SV_Position;
    float2 texCoord : TEXCOORD0;
};

BackdropVSOutput BackdropVS( BackdropVSInput input )
{
    BackdropVSOutput output;
    output.position = input.position;
    output.texCoord = input.texCoord;
    return output;
}

float inside( float2 uv )
{
    return step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 );
}

float4 BackdropPS( BackdropVSOutput input ) : SV_Target
{
    float2 uv = input.texCoord * BackdropTransform.xy + BackdropTransform.zw;
    // Both are sampled outside any branch: implicit-derivative samples must be.
    float4 smooth = BackdropMap.Sample( LinearClamp, uv );
    float4 nearest = BackdropPointMap.Sample( PointClamp, uv );
    float3 col = lerp( smooth.rgb, nearest.rgb, BackdropSettings.x );

    // The marker, tiled twice each way in a square at the lower left (wrap addressing, alpha from the PNG).
    float2 markerUv = ( input.texCoord - float2( 0.03, 0.62 ) ) / float2( 0.18, 0.32 );
    float4 marker = MarkerMap.Sample( LinearWrap, markerUv * 2.0 );
    col = lerp( col, marker.rgb, marker.a * inside( markerUv ) * BackdropSettings.y );

    // The page's canvas at the lower right.
    float2 canvasUv = ( input.texCoord - float2( 0.79, 0.62 ) ) / float2( 0.18, 0.32 );
    float4 drawn = CanvasMap.Sample( LinearClamp, canvasUv );
    col = lerp( col, drawn.rgb, drawn.a * inside( canvasUv ) * BackdropSettings.y );
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
        VertexShader = compile vs_5_0 BackdropVS();
        PixelShader = compile ps_5_0 BackdropPS();
    }
}
