"use client";

// The nebula, drawn on a camera-locked fullscreen quad (always fills the view, whichever
// way the camera drifts). depthTest off + renderOrder -10 keeps it behind the 3D stars.
// Scroll drives the shader's uScroll (dive); the pointer drives a subtle parallax.

import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector2, Vector3, type Mesh, type ShaderMaterial, type PerspectiveCamera } from "three";
import { nebulaVertex, nebulaFragment } from "./nebulaShader";
import { scrollState } from "./cameraStore";

const _dir = new Vector3();

export function NebulaBackdrop() {
  const mesh = useRef<Mesh>(null);
  const mat = useRef<ShaderMaterial>(null);
  const { size } = useThree();

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uScroll: { value: 0 },
      uResolution: { value: new Vector2(1, 1) },
      uMouse: { value: new Vector2(0, 0) },
    }),
    [],
  );

  useFrame((state, delta) => {
    const cam = state.camera as PerspectiveCamera;
    const dist = 10;
    const h = 2 * Math.tan((cam.fov * Math.PI) / 360) * dist;
    const w = h * (size.width / size.height);
    if (mesh.current) {
      cam.getWorldDirection(_dir);
      mesh.current.position.copy(cam.position).addScaledVector(_dir, dist);
      mesh.current.quaternion.copy(cam.quaternion);
      mesh.current.scale.set(w, h, 1);
    }
    if (mat.current) {
      const u = mat.current.uniforms;
      u.uTime.value += delta;
      u.uScroll.value += (scrollState.progress - u.uScroll.value) * Math.min(1, delta * 3);
      u.uResolution.value.set(size.width, size.height);
      u.uMouse.value.x += (state.pointer.x - u.uMouse.value.x) * Math.min(1, delta * 2);
      u.uMouse.value.y += (state.pointer.y - u.uMouse.value.y) * Math.min(1, delta * 2);
    }
  });

  return (
    <mesh ref={mesh} renderOrder={-10} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <shaderMaterial
        ref={mat}
        args={[{
          uniforms,
          vertexShader: nebulaVertex,
          fragmentShader: nebulaFragment,
          depthTest: false,
          depthWrite: false,
        }]}
      />
    </mesh>
  );
}
