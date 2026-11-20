// Request proof page: flat shapes given straight in clip space (x, y in -1..1), a colour per vertex.
#ifndef REQ_FXH
#define REQ_FXH

struct FlatVSInput
{
    float3 position : POSITION;    // clip-space x, y; z unused
    float4 colour : TEXCOORD0;     // rgba (show.fx: xy the texel coordinate, z an offset, w a scale)
};

struct FlatVSOutput
{
    float4 position : SV_Position;
    float4 colour : TEXCOORD0;
};

FlatVSOutput FlatVS( FlatVSInput input )
{
    FlatVSOutput output;
    output.position = float4( input.position.xy, 0.5, 1.0 );
    output.colour = input.colour;
    return output;
}

#endif
