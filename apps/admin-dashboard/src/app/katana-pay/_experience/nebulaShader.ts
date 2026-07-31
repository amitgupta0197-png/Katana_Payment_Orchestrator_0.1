// Volumetric deep-space nebula, rendered as a single fullscreen fragment shader. Domain-
// warped fBm sculpts flowing gas filaments; a dark, moody, near-monochrome teal grade
// keeps most of the frame a black void with faint wisps only in the densest regions.
// uScroll zooms + travels the field so scrolling reads as drifting through the clouds.

export const nebulaVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const nebulaFragment = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uScroll;
  uniform vec2  uResolution;
  uniform vec2  uMouse;
  varying vec2  vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 6; i++) {
      v += a * noise(p);
      p = m * p;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv - 0.5;
    uv.x *= uResolution.x / uResolution.y;

    float zoom = 1.0 + uScroll * 2.2;
    vec2 p = uv * (2.4 / zoom) + vec2(uTime * 0.015, uScroll * 2.2) + uMouse * 0.12;

    vec2 q = vec2(fbm(p), fbm(p + vec2(3.1, 1.7)));
    vec2 r = vec2(fbm(p + 3.5 * q + vec2(1.7, 9.2)), fbm(p + 3.5 * q + vec2(8.3, 2.8)));
    float f = fbm(p + 3.5 * r);

    // DARK & MOODY grade: near-pure-black void with faint dark-teal gas that only surfaces
    // in the densest fBm regions (high threshold → sparse tendrils, not a wash).
    vec3 col = vec3(0.006, 0.011, 0.013);
    float gas = smoothstep(0.5, 0.92, f);
    col = mix(col, vec3(0.02, 0.11, 0.12), gas);
    float fil = smoothstep(0.62, 1.0, length(r)) * gas;
    col = mix(col, vec3(0.06, 0.26, 0.28), fil);
    col = mix(col, vec3(0.16, 0.42, 0.44), pow(gas, 4.0) * 0.5);
    col *= 0.45 + 0.55 * gas;

    // Sparse, faint stars — dim cool-white pinpricks scattered through the void.
    vec2 sp = uv * zoom * 220.0;
    vec2 gp = floor(sp);
    float h = hash(gp);
    if (h > 0.986) {
      vec2 c = fract(sp) - 0.5;
      float d = length(c);
      float tw = 0.6 + 0.4 * sin(uTime * 2.0 + h * 60.0);
      float bright = smoothstep(0.42, 0.0, d) * tw * 0.7;
      col += bright * vec3(0.55, 0.72, 0.75);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;
