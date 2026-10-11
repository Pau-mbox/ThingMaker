import type { ChillAudio } from "../types";
/** Original, quiet wind ambience. Construct only after an explicit user gesture. */
export function ambience(): ChillAudio | null {
  if (typeof AudioContext === "undefined") return null;
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.25;
  master.connect(ctx.destination);
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate),
    data = buffer.getChannelData(0);
  let previous = 0;
  for (let i = 0; i < data.length; i++) {
    previous = (previous + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = previous * 3;
  }
  const wind = ctx.createBufferSource();
  wind.buffer = buffer;
  wind.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 550;
  const volume = ctx.createGain();
  volume.gain.value = 0.08;
  wind.connect(filter);
  filter.connect(volume);
  volume.connect(master);
  wind.start();
  const tones = [164.81, 246.94, 329.63].map((frequency) => {
    const o = ctx.createOscillator(),
      gain = ctx.createGain();
    o.type = "sine";
    o.frequency.value = frequency;
    gain.gain.value = 0.003;
    o.connect(gain);
    gain.connect(master);
    o.start();
    return o;
  });
  void ctx.resume().catch(() => undefined);
  let stopped = false;
  return {
    setVolume: (volume) => {
      master.gain.setTargetAtTime(
        Math.max(0, Math.min(1, volume)),
        ctx.currentTime,
        0.15,
      );
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      wind.stop();
      tones.forEach((o) => o.stop());
      void ctx.close().catch(() => undefined);
    },
    suspend: (hidden) => {
      if (stopped) return;
      void (hidden ? ctx.suspend() : ctx.resume()).catch(() => undefined);
    },
  };
}
