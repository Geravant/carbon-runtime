// Shattered Reach spike: the constant blocks our own effects read.
//
// The engine's effect compiler moves a global struct variable named PerFrameVS
// into constant buffer b1, PerFramePS into b2, PerObjectVS into b3 and
// PerObjectPS into b4 (ParserUtils PatchCBuffers). The layouts are ours: the
// page fills them from src of the same names in main.js (ShatteredLayouts).
// Matrices are column_major and uploaded transposed, as the engine does.

#ifndef SHATTEREDFRAME_FXH
#define SHATTEREDFRAME_FXH

struct ShatteredPerFrameVSData
{
    column_major float4x4 ViewProjectionMat;   // c0
    column_major float4x4 ViewMat;             // c4
} PerFrameVS;

struct ShatteredPerFramePSData
{
    float4 LightDirection;   // c0: xyz toward the light, in view space
    float4 Paper;            // c1: rgb the paper the wash is laid on
    float4 Paint;            // c2: x engine glow 0..1, y wash 0..1, z time (s), w unused
} PerFramePS;

struct ShatteredObjectVSData
{
    column_major float4x4 worldTransform;   // c0
} PerObjectVS;

#endif // SHATTEREDFRAME_FXH
