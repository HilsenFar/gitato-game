// Runs the GAME'S OWN analyzeFile() (verbatim from app.bundle.js) on PCM files,
// so we know exactly what beat grid the game will derive for each track.
// Usage: node analyze_like_game.mjs file.f32raw <sampleRate>
import { readFileSync } from "fs";

function mean(a) { let s = 0; for (const v of a) s += v; return s / a.length; }
function std(a) { const m = mean(a); let s = 0; for (const v of a) s += (v - m) * (v - m); return Math.sqrt(s / a.length); }

// —— verbatim port of analyzeFile (audio-analysis core) ——
function analyzeFile(audioBuffer) {
  const sr = audioBuffer.sampleRate;
  const ch = audioBuffer.getChannelData(0);
  const hop = 512;
  const frames = Math.max(1, Math.floor(ch.length / hop) - 1);
  const fps = sr / hop;
  const lowE = new Float32Array(frames);
  const midE = new Float32Array(frames);
  const highE = new Float32Array(frames);
  {
    const kLow = 1 - Math.exp(-2 * Math.PI * 150 / sr);
    const kMid = 1 - Math.exp(-2 * Math.PI * 2e3 / sr);
    let lp1 = 0, lp2 = 0;
    for (let f = 0; f < frames; f++) {
      let lo = 0, mi = 0, hi = 0;
      const i0 = f * hop;
      for (let i = 0; i < hop; i++) {
        const s = ch[i0 + i] || 0;
        lp1 += kLow * (s - lp1);
        lp2 += kMid * (s - lp2);
        const low = lp1, mid = lp2 - lp1, high = s - lp2;
        lo += low * low;
        mi += mid * mid;
        hi += high * high;
      }
      lowE[f] = Math.sqrt(lo / hop);
      midE[f] = Math.sqrt(mi / hop);
      highE[f] = Math.sqrt(hi / hop);
    }
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, lowE[f] - lowE[f - 1]);
  const lagMin = Math.max(2, Math.floor(60 / 260 * fps));
  const lagMax = Math.min(frames - 1, Math.ceil(60 / 110 * fps));
  const ac = new Float32Array(lagMax + 2);
  let bestLag = lagMin, bestScore = -1;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += onset[f] * onset[f - lag];
    ac[lag] = s;
    if (s > bestScore) { bestScore = s; bestLag = lag; }
  }
  let refinedLag = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
    const den = a - 2 * b + c;
    if (den !== 0) refinedLag = bestLag + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
  }
  let bestBpm = 60 * fps / refinedLag;
  const cands = [bestBpm, bestBpm * 2, bestBpm / 2, bestBpm * 1.5, bestBpm / 1.5].filter((c) => c >= 135 && c <= 220);
  if (cands.length) bestBpm = cands.reduce((p, c) => Math.abs(c - 160) < Math.abs(p - 160) ? c : p);
  bestBpm = Math.round(bestBpm * 10) / 10;
  const secPerBeat = 60 / bestBpm;
  const lagF = secPerBeat * fps;
  let bestPhase = 0, bestPhaseScore = -1;
  for (let p = 0; p < 32; p++) {
    const off = p / 32 * lagF;
    let s = 0;
    for (let pos = off; pos < frames; pos += lagF) {
      const f = Math.round(pos);
      s += (onset[f] || 0) + (onset[f + 1] || 0) * 0.5 + (onset[f - 1] || 0) * 0.5;
    }
    if (s > bestPhaseScore) { bestPhaseScore = s; bestPhase = off / fps; }
  }
  // beat-grid regularity score: fraction of grid points landing on a local onset peak
  let hits = 0, gridN = 0;
  for (let pos = bestPhase * fps; pos < frames; pos += lagF) {
    const f = Math.round(pos);
    gridN++;
    const window = 2;
    let isPeak = false;
    for (let w = -window; w <= window; w++) {
      const i = f + w;
      if (i > 1 && i < frames - 1 && onset[i] > 0 && onset[i] >= onset[i - 1] && onset[i] >= onset[i + 1]) { isPeak = true; break; }
    }
    if (isPeak) hits++;
  }
  return { bpm: bestBpm, beatOffset: bestPhase, duration: audioBuffer.duration, gridHitRate: +(hits / gridN).toFixed(3) };
}

const [file, srArg] = process.argv.slice(2);
const sr = parseInt(srArg, 10);
const raw = readFileSync(file);
const ch = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const res = analyzeFile({ sampleRate: sr, getChannelData: () => ch, duration: ch.length / sr });
console.log(JSON.stringify({ file, ...res }));
