// Tiny WebAudio layer: low drone, scan ticks, spotted thud, claim chime.
export function createRoomAudio() {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let muted = false;
  function unlock() {
    if (!ctx) {
      const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!C) return;
      ctx = new C(); master = ctx.createGain(); master.gain.value = muted ? 0 : 0.7; master.connect(ctx.destination);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 180;
      const g = ctx.createGain(); g.gain.value = 0.05; g.connect(f); f.connect(master);
      for (const [hz, type] of [[55, 'sine'], [82.4, 'sine'], [110, 'triangle']] as const) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz; o.connect(g); o.start();
      }
    }
    if (ctx.state === 'suspended') void ctx.resume();
  }
  function tone(hz: number, dur: number, type: OscillatorType = 'sine', vol = 0.15, slide = 0) {
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(hz, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, hz + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  return {
    unlock,
    scan: (n: number) => tone(420 + n * 90, 0.12, 'sine', 0.1),
    spotted: () => { tone(140, 0.35, 'sawtooth', 0.18, -90); },
    claim: (kind: 'good' | 'dud' | 'hazard') => {
      if (kind === 'good') { tone(660, 0.18, 'triangle', 0.14); setTimeout(() => tone(990, 0.28, 'triangle', 0.12), 90); }
      else tone(kind === 'hazard' ? 110 : 220, 0.3, 'square', 0.08, -60);
    },
    eye: () => tone(196, 0.5, 'sine', 0.05, 30),
    toggle() { muted = !muted; if (master) master.gain.value = muted ? 0 : 0.7; return muted; },
  };
}
