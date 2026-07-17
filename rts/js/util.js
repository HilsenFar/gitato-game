// GITATO COMMAND — math helpers, seeded RNG, tiny synth SFX
'use strict';

RTS.util = (() => {
  // mulberry32 — small seeded PRNG so both peers generate the same map
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  function roomCode(n) {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
    let s = '';
    for (let i = 0; i < n; i++) s += abc[(Math.random() * abc.length) | 0];
    return s;
  }

  // ---- tiny WebAudio synth (no audio assets) ----
  let actx = null, muted = false, master = null;
  function audio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.35;
      master.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(freq, dur, type, vol, slide) {
    if (muted || !audio()) return;
    const t0 = actx.currentTime;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
    g.gain.setValueAtTime(vol || 0.12, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function noise(dur, vol, low) {
    if (muted || !audio()) return;
    const t0 = actx.currentTime;
    const len = Math.floor(actx.sampleRate * dur);
    const buf = actx.createBuffer(1, len, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = actx.createBufferSource(); src.buffer = buf;
    const g = actx.createGain(); g.gain.value = vol || 0.2;
    const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = low || 900;
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0);
  }
  const sfx = {
    click:   () => tone(880, 0.05, 'square', 0.06),
    select:  () => tone(520, 0.05, 'triangle', 0.08),
    order:   () => tone(660, 0.07, 'triangle', 0.08, 200),
    shot:    () => tone(1400, 0.06, 'sawtooth', 0.04, -900),
    hit:     () => tone(220, 0.06, 'square', 0.05, -80),
    boom:    () => noise(0.25, 0.22, 700),
    bigboom: () => { noise(0.6, 0.3, 400); tone(80, 0.5, 'sine', 0.2, -40); },
    deposit: () => tone(1046, 0.09, 'sine', 0.08, 300),
    built:   () => { tone(523, 0.1, 'triangle', 0.09); setTimeout(() => tone(784, 0.12, 'triangle', 0.09), 90); },
    error:   () => tone(160, 0.15, 'square', 0.08, -40),
    victory: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.25, 'triangle', 0.12), i * 140)),
    defeat:  () => [392, 330, 262, 196].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'sawtooth', 0.08), i * 180)),
  };
  function toggleMute() { muted = !muted; return muted; }

  return { rng, dist, dist2, clamp, lerp, roomCode, sfx, toggleMute, audio };
})();
