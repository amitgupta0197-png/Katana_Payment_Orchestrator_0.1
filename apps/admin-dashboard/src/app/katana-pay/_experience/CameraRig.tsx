"use client";

// Frame-rate-independent camera damper. Reads the mutable camState targets (written by
// GSAP) and eases the real camera toward them each frame. We drive rotation DIRECTLY
// (not lookAt) so the GSAP-authored yaw/pitch on the dive apply verbatim.

import { useFrame } from "@react-three/fiber";
import { MathUtils } from "three";
import { camState } from "./cameraStore";

export function CameraRig() {
  useFrame((state, delta) => {
    const c = state.camera;
    // Exponential damping: t = 1 - base^dt. Independent of frame rate, so the feel is
    // identical at 30 or 144fps. base≈0.0025 → snappy but smooth (~0.3s to settle).
    const t = 1 - Math.pow(0.0025, delta);
    c.position.x = MathUtils.lerp(c.position.x, camState.x, t);
    c.position.y = MathUtils.lerp(c.position.y, camState.y, t);
    c.position.z = MathUtils.lerp(c.position.z, camState.z, t);
    c.rotation.x = MathUtils.lerp(c.rotation.x, camState.rotX, t);
    c.rotation.y = MathUtils.lerp(c.rotation.y, camState.rotY, t);
    c.rotation.z = MathUtils.lerp(c.rotation.z, camState.rotZ, t);
  });
  return null;
}
