"use client";

// Near star layer as real 3D points, distributed through a VOLUME so the camera's forward
// glide parallaxes them against the screen-locked nebula. Faint, cool, desaturated so they
// stay subtle against the moody dark gas.

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, Color, type Points } from "three";

export function Starfield({ count = 1200, spread = 46 }: { count?: number; spread?: number }) {
  const ref = useRef<Points>(null);

  const { positions, colors } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const tints = [new Color("#9fb8c4"), new Color("#8fb3bd"), new Color("#c8d6dc"), new Color("#7fa6b0")];
    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * spread * 2;
      positions[i * 3 + 1] = (Math.random() - 0.5) * spread * 2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * spread * 2;
      const t = tints[(Math.random() * tints.length) | 0];
      const b = 0.35 + Math.random() * 0.4;
      colors[i * 3 + 0] = t.r * b;
      colors[i * 3 + 1] = t.g * b;
      colors[i * 3 + 2] = t.b * b;
    }
    return { positions, colors };
  }, [count, spread]);

  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.y += delta * 0.005;
  });

  return (
    <points ref={ref} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.09}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.6}
        depthWrite={false}
        blending={AdditiveBlending}
      />
    </points>
  );
}
