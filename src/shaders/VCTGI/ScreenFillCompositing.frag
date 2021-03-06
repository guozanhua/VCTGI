#version 440
#extension GL_EXT_gpu_shader4 : enable
#extension GL_NV_explicit_multisample : enable

in vec2 passUVCoord;

uniform sampler2D colorMap;
uniform sampler2D normalMap;
uniform sampler2D depthMap;
uniform sampler2D directIlluminationMap;
uniform samplerRenderbuffer globalIlluminationMap;
uniform samplerRenderbuffer ambientOcclusionMap;

uniform float uniformGlobalIlluminationAlpha;
uniform float uniformAmbientOcclusionAlpha;

uniform int outputMode;

layout(location = 0) out vec4 fragColor;

/*const float kernel5[25] = float[25] (1,  4,  7,  4, 1,
                                     4, 16, 26, 16, 4,
                                     7, 26, 41, 26, 7,
                                     4, 16, 26, 16, 4,
                                     1,  4,  7,  4, 1);

const float kernel3[9] = float[9] (1, 2, 1,
                                   2, 4, 2,
                                   1, 2, 1);*/

const float kernel7[7][7] = float[7][7] (float[7] ( 1,  4,  8, 10,  8,  4,  1),
                                         float[7] ( 4, 12, 24, 30, 24, 12,  4),
                                         float[7] ( 8, 24, 47, 59, 47, 24,  8),
                                         float[7] (10, 30, 59, 73, 59, 30, 10),
                                         float[7] ( 8, 24, 47, 59, 47, 24,  8),
                                         float[7] ( 4, 12, 24, 30, 24, 12,  4),
                                         float[7] ( 1,  4,  8, 10,  8,  4,  1));

// Sample positions of the 4xRGSS pattern, Y coordinate up.
const ivec2 samplePositions[2][2] = ivec2[2][2] (ivec2[2] (ivec2(1, 0), ivec2(1, 1)),
                                                 ivec2[2] (ivec2(0, 0), ivec2(0, 1)));

ivec3 uvToSampleCoords(ivec2 uv) {
  ivec3 uvCoordS = ivec3(uv.xy, (uv.y % 2) * 2 + uv.x % 2);
  uvCoordS.xy /= 2;
  return clamp(uvCoordS, ivec3(0), ivec3(200-1, 150-1, 3));
}

const float twoSigmaSquared = 0.14;
float similarity(vec4 a, vec4 b, float scale) {
  float d = scale * length(a - b);
  return exp(-(d * d/ twoSigmaSquared));
}


vec4 upsampleBilaterally(samplerRenderbuffer map) {
  const vec2 texelSize = vec2(1.0 / 800.0, 1.0 / 600.0);
  const ivec2 uvCoordFI = ivec2(passUVCoord * vec2(800, 600));  // TODO resolution via uniform
  const ivec2 uvCoordLI = ivec2(passUVCoord * vec2(400, 300));
  
  const vec4 centerN = texelFetch(normalMap, uvCoordFI, 0);
  const vec4 centerD = texelFetch(depthMap, uvCoordFI, 0);
  
  const ivec2 bias = uvCoordFI % 2;
  const int radXMin = -1;//-1 - int(!bool(bias.x));
  const int radXMax = 1;//1 + bias.x;
  const int radYMin = -1;//-1 - int(!bool(bias.y));
  const int radYMax = 1;//1 + bias.y;
  
  float weightSum = 0;
  vec4 val = vec4(0);
  for (int y = radXMin; y <= radXMax; y++) {
    for (int x = radYMin; x <= radYMax; x++) {
      ivec2 coord = uvCoordLI + ivec2(x, y);
      
      // Match sample position of RGSS pattern.
      ivec2 patternFraction = coord % ivec2(2);
      ivec2 coordF = 2 * coord + samplePositions[patternFraction.y][patternFraction.x];
      vec2 coordFf = texelSize * coordF;
      
      ivec2 kernelCoord = ivec2(3) + coordF - uvCoordFI;
      
      // Make sure the positing inside the kernel.
      if (any(lessThan(kernelCoord, ivec2(0))) || any(greaterThan(kernelCoord, ivec2(6)))) continue;

      float weightKernel = kernel7[kernelCoord.y][kernelCoord.x];
      float weightN = similarity(centerN, texelFetch(normalMap, coordF, 0), 1.0);
      float weightD = similarity(centerD, texelFetch(depthMap, coordF, 0), 100.0);
      
      ivec3 coordS = uvToSampleCoords(coord);
      vec4 texelSample = max(vec4(0), texelFetchRenderbuffer(map, coordS.xy, coordS.z));
    
      float weight = weightKernel * weightN * weightD;
      val += texelSample * weight;
      weightSum += weight;
    }
  }

  /*
  ivec2 kernelBias = uvCoordFI % ivec2(2);
  const int kernelRadius = 2;
  const int kernelSize = 5;
  const float kernel[] = kernel5;

  float weightSum = 0;
  vec4 val = vec4(0);
  for (int y = -kernelRadius; y <= kernelRadius; y++) {
    for (int x = -kernelRadius; x <= kernelRadius; x++) {
      ivec2 coord = uvCoordLI + ivec2(x, y);
      ivec2 kernelCoord = ivec2(x, y) + ivec2(kernelRadius);

      // Match sample position of RGSS pattern
      ivec2 patternFraction = coord % ivec2(2);
      ivec2 coordF = 2 * coord + samplePositions[patternFraction.y][patternFraction.x];
      vec2 coordFf = texelSize * coordF;


      / *
        ivec2 biased = kernelCoord - kernelBias + samplePositions[kernelBias.y][1-kernelBias.x] - ivec2(1);
      float kernelWeight = 1;
      if (biased.x < kernelSize && biased.y < kernelSize && biased.x >= 0 && biased.y >= 0) {
        kernelWeight = kernel[kernelSize * biased.y + biased.x];
        }* /

      float kernelWeight = kernel[kernelSize * kernelCoord.x + kernelCoord.y];

      float weightN = similarity(centerN, texelFetch(normalMap, coordF, 0), 1.0);
      float weightD = similarity(centerD, texelFetch(depthMap, coordF, 0), 100.0);
      // TODO adaptive depth scaling (max - min)

      ivec3 coordS = uvToSampleCoords(coord);
      vec4 texelSample = max(vec4(0), texelFetchRenderbuffer(map, coordS.xy, coordS.z));

      float weight = kernelWeight * weightN * weightD;
      val += texelSample * weight;
      weightSum += weight;
    }
  }
  */
  return val / weightSum;
}

void main() {

  vec4 color = texture(colorMap, passUVCoord);
  vec4 directIllumination = texture(directIlluminationMap, passUVCoord);

  vec4 globalIllumination = vec4(upsampleBilaterally(globalIlluminationMap).rgb, 1);
  float ambientOcclusion = upsampleBilaterally(ambientOcclusionMap).x;

  fragColor = clamp(color * (directIllumination + globalIllumination * uniformGlobalIlluminationAlpha), 0.0, 1.0);
  fragColor = min(uniformAmbientOcclusionAlpha + ambientOcclusion, 1) * fragColor;

  /*
    ivec3 coord = uvToSampleCoords(ivec2(passUVCoord * vec2(400, 300)));
    globalIllumination = texelFetchRenderbuffer(globalIlluminationMap, coord.xy, coord.z);
    ambientOcclusion = texelFetchRenderbuffer(ambientOcclusionMap, coord.xy, coord.z).r;
  */
  
  if (outputMode == 1) fragColor = vec4(globalIllumination);
  if (outputMode == 2) fragColor = vec4(ambientOcclusion);

  /* gl_FragColor = clamp((color * 2.5
                        * (0.4 * directIllumination + pow(globalIllumination, vec4(uniformGlobalIlluminationAlpha)))
                        ) * (1 - uniformAmbientOcclusionAlpha * (1 - ambientOcclusion)), 0.0, 1.0);  // Gamma */

}
