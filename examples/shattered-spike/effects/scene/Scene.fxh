// Shattered Reach capability page (scene.html): the constant blocks its effects read.
// PerFrameVS -> b1, PerFramePS -> b2, PerObjectVS -> b3 by name, as in ../ShatteredFrame.fxh.
// Matrices are uploaded transposed (SetAndTranspose) and used as mul( vector, matrix ).

#ifndef SCENE_FXH
#define SCENE_FXH

struct ScenePerFrameVSData
{
    column_major float4x4 ViewProjectionMat;   // c0
    float4 CameraRight;                        // c4: xyz the camera's right axis in the world
    float4 CameraUp;                           // c5: xyz the camera's up axis in the world
    float4 Viewport;                           // c6: x width, y height (pixels), z time (s)
} PerFrameVS;

struct ScenePerFramePSData
{
    float4 LightDirection;   // c0: xyz toward the light, in the world
    float4 Time;             // c1: x time (s)
} PerFramePS;

struct SceneObjectVSData
{
    column_major float4x4 worldTransform;   // c0
} PerObjectVS;

#endif // SCENE_FXH
