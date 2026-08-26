import { useEffect, useRef, useState } from "react";

/**
 * Generates a looping two-tone siren using the Web Audio API — no external
 * audio file to host or load. Sounds while `isDanger` is true and the user
 * hasn't muted it. The mute flag auto-resets once danger clears, so the
 * next danger event alarms again instead of staying silently muted forever.
 */
export function useDangerAlarm(isDanger: boolean) {
  const [muted, setMuted] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscRef = useRef<OscillatorNode | null>(null);
  const wailIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isDanger) setMuted(false);
  }, [isDanger]);

  useEffect(() => {
    const shouldPlay = isDanger && !muted;

    if (shouldPlay && !audioCtxRef.current) {
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        gain.gain.value = 0.15; // firm but not painful — adjust to taste
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        ctx.resume().catch(() => {
          // Autoplay was blocked — will resume on the next user click
          // anywhere in the app since AudioContext stays queued up.
        });

        audioCtxRef.current = ctx;
        oscRef.current = osc;

        // Wail the pitch up and down like a siren, ~1.2s per cycle.
        let rising = true;
        let freq = 500;
        wailIntervalRef.current = window.setInterval(() => {
          freq += rising ? 40 : -40;
          if (freq >= 900) rising = false;
          if (freq <= 500) rising = true;
          osc.frequency.setValueAtTime(freq, ctx.currentTime);
        }, 50);
      } catch (err) {
        console.error("Failed to start alarm tone:", err);
      }
    }

    if (!shouldPlay && audioCtxRef.current) {
      if (wailIntervalRef.current) clearInterval(wailIntervalRef.current);
      oscRef.current?.stop();
      audioCtxRef.current.close();
      audioCtxRef.current = null;
      oscRef.current = null;
      wailIntervalRef.current = null;
    }
  }, [isDanger, muted]);

  // Cleanup if the component unmounts while still sounding.
  useEffect(() => {
    return () => {
      if (wailIntervalRef.current) clearInterval(wailIntervalRef.current);
      oscRef.current?.stop();
      audioCtxRef.current?.close();
    };
  }, []);

  return {
    isSounding: isDanger && !muted,
    mute: () => setMuted(true),
  };
}
