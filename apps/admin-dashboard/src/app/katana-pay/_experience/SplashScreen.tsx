"use client";

// One-time intro splash: the first time a visitor opens the Katana Pay site, a fullscreen
// video plays over everything, then fades out. A localStorage flag makes it show ONCE per
// browser — return visits skip it. Muted autoplay (browsers block sound-on autoplay),
// with a Skip button and error/timeout fallbacks so a visitor is never stuck on black.

import { useEffect, useRef, useState } from "react";

// Bump the version suffix to re-show the splash to everyone after changing the video.
const SEEN_KEY = "katana_intro_seen_v1";

export function SplashScreen() {
  const [show, setShow] = useState(false);   // hidden on SSR / until we've checked storage
  const [fading, setFading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let seen = false;
    try { seen = !!localStorage.getItem(SEEN_KEY); } catch { /* storage blocked → show once */ }
    if (seen) return;
    setShow(true);
    // Lock scroll while the splash is up.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Safety: never trap the visitor if the video stalls/doesn't fire 'ended'.
    const fallback = setTimeout(() => dismiss(), 13000);
    return () => { document.body.style.overflow = prevOverflow; clearTimeout(fallback); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismiss() {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    setFading(true);
    document.body.style.overflow = "";
    setTimeout(() => setShow(false), 600);   // let the fade finish
  }

  // Nudge playback once the overlay mounts — some browsers ignore the autoplay
  // attribute on a dynamically-inserted element but honour an explicit muted play().
  function kickoff() {
    const v = videoRef.current;
    if (v) { v.muted = true; v.play().catch(() => { /* blocked → Skip button / timeout */ }); }
  }

  if (!show) return null;

  return (
    <div
      className={`fixed inset-0 z-[300] bg-black transition-opacity duration-500 ${fading ? "opacity-0" : "opacity-100"}`}
      role="dialog"
      aria-label="Intro"
    >
      <video
        ref={videoRef}
        src="/intro.mp4"
        autoPlay
        muted
        playsInline
        preload="auto"
        onLoadedData={kickoff}
        onCanPlay={kickoff}
        onEnded={dismiss}
        onError={dismiss}
        className="absolute inset-0 h-full w-full object-cover"
      />
      <button
        type="button"
        onClick={dismiss}
        className="absolute bottom-6 right-6 rounded-full border border-white/25 bg-black/40 px-5 py-2 text-sm font-medium text-white/90 backdrop-blur transition-colors hover:border-white/50 hover:bg-black/60"
      >
        Skip ✕
      </button>
    </div>
  );
}
