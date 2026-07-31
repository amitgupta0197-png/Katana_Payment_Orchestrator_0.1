// Shared MUTABLE camera targets. GSAP ScrollTrigger scrubs these; the R3F <CameraRig>
// damps the real camera toward them each frame. Module singleton → no React re-renders.
//
// The nebula "dive" lives in the shader (uScroll zoom+travel), so the camera only does a
// gentle forward push + slow yaw — enough to parallax the 3D starfield against the gas.

export interface CamTarget {
  x: number; y: number; z: number;
  rotX: number; rotY: number; rotZ: number;
}

export const camState: CamTarget = {
  x: 0, y: 0, z: 8,
  rotX: 0, rotY: 0, rotZ: 0,
};

// Global scroll progress 0..1 (top → bottom). Drives the nebula shader's uScroll.
export const scrollState = { progress: 0 };

// Gentle glide forward through the starfield (z 8 → −4) with a faint yaw drift.
export const CAM_KEYFRAMES = {
  hero:     { x: 0.0,  y: 0.0,  z: 8.0,  rotX: 0.0,   rotY: 0.0,   rotZ: 0.0 },
  features: { x: 0.4,  y: 0.1,  z: 4.5,  rotX: -0.02, rotY: 0.12,  rotZ: 0.0 },
  api:      { x: -0.4, y: -0.1, z: 1.0,  rotX: 0.02,  rotY: -0.10, rotZ: 0.0 },
  end:      { x: 0.0,  y: 0.15, z: -4.0, rotX: 0.02,  rotY: 0.06,  rotZ: 0.0 },
} as const;
