"use client";

// Persistent WebGL canvas. Fixed, full-viewport, z-0 (opaque fallback at -z-10, UI at
// z-10 — the 3D is never occluded). Dynamically imported ssr:false. DPR capped at 1.5:
// the nebula is a heavy fullscreen fBm shader. Post: gentle Bloom, a whisper of chromatic
// aberration, film-grain Noise, soft vignette. Fades up from black on mount.

import { Canvas } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Vector2 } from "three";
import { EffectComposer, Bloom, ChromaticAberration, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import { CameraRig } from "./CameraRig";
import { NebulaBackdrop } from "./NebulaBackdrop";
import { Starfield } from "./Starfield";
import { camState } from "./cameraStore";

export default function Scene() {
  const caOffset = useMemo(() => new Vector2(0.0008, 0.0008), []);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className={`pointer-events-none fixed inset-0 z-0 transition-opacity duration-[1400ms] ease-out ${shown ? "opacity-100" : "opacity-0"}`}>
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
        camera={{ position: [camState.x, camState.y, camState.z], fov: 60, near: 0.1, far: 200 }}
      >
        <color attach="background" args={["#020207"]} />

        <Suspense fallback={null}>
          <CameraRig />
          <NebulaBackdrop />
          <Starfield />

          <EffectComposer>
            <Bloom mipmapBlur intensity={0.4} luminanceThreshold={0.6} luminanceSmoothing={0.6} radius={0.7} />
            <ChromaticAberration blendFunction={BlendFunction.NORMAL} offset={caOffset} radialModulation modulationOffset={0.35} />
            <Noise premultiply blendFunction={BlendFunction.OVERLAY} opacity={0.14} />
            <Vignette offset={0.35} darkness={0.6} eskil={false} />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
}
