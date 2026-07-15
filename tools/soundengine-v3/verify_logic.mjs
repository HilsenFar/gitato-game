// Verification suite: extracts the MODIFIED sections out of app.bundle.js and
// checks (a) taste picker steering, (b) per-genre composition distinctness,
// (c) bundled-track fallback correctness. Exits non-zero on any failure.
import { readFileSync } from "fs";
import vm from "vm";

const bundle = readFileSync("../../app.bundle.js", "utf8");
let failures = [];
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failures.push(msg); };

// ---- extract gen-music section (GENRES … GenMusic class incl. compose) ----
function section(startMarker, endMarker) {
  const a = bundle.indexOf(startMarker);
  const b = bundle.indexOf(endMarker, a + 1);
  if (a < 0 || b < 0) throw new Error("markers not found: " + startMarker + " → " + endMarker);
  return bundle.slice(a, b);
}
const genSrc = section("// renderer/js/engine/gen-music.js", "// node_modules/three/examples/jsm/shaders/CopyShader.js");

const sandbox = { Math, console, KICK_RECIPE: {}, localStorage: { getItem: () => null, setItem: () => {} } };
vm.createContext(sandbox);
vm.runInContext(genSrc.replace(/^\s*\/\/ renderer.*$/m, ""), sandbox);
const { GENRES, GENRE_PLANS, GenMusic, kickBeatsFor } = sandbox;
ok(!!GENRES && !!GenMusic && !!GENRE_PLANS && !!kickBeatsFor, "gen-music section extracted & evaluated");

// ---- extract taste section ----
const tasteStart = bundle.indexOf("var GENRE_VIBES = {");
const tasteEnd = bundle.indexOf("// renderer/js/engine/jukebox.js");
vm.runInContext(bundle.slice(tasteStart, tasteEnd), sandbox);
const { Taste, GENRE_VIBES } = sandbox;
ok(!!Taste && !!GENRE_VIBES, "taste section extracted & evaluated");

// ---- (a) picker steering ----
function dist(sliders, n = 4000) {
  const t = new Taste();
  t.setSliders(sliders);
  const c = {};
  for (let i = 0; i < n; i++) { const g = t.pick(); c[g] = (c[g] || 0) + 1; }
  return c;
}
const share = (c, genres, n = 4000) => genres.reduce((s, g) => s + (c[g] || 0), 0) / n;

const psyMax = dist({ hardness: 0.3, speed: 0.5, darkness: 0.4, bounce: 0.6, psy: 1 });
const psyShare = share(psyMax, ["psytrance", "psychedelic", "forestpsy"]);
ok(psyShare >= 0.6, `psy sliders → psy branch dominates (got ${(psyShare * 100).toFixed(1)}%, need ≥60%)`);

const darkMax = dist({ hardness: 1, speed: 0.7, darkness: 1, bounce: 0.3, psy: 0 });
const indShare = share(darkMax, ["industrialhardcore", "terror", "crossbreed", "gabber", "hardcore", "rawstyle"]);
ok(indShare >= 0.75, `dark+hard sliders → industrial/hard branch dominates (got ${(indShare * 100).toFixed(1)}%, need ≥75%)`);

const def = dist({ hardness: 0.6, speed: 0.6, darkness: 0.5, bounce: 0.6, psy: 0.3 });
const distinctDefault = Object.keys(def).length;
ok(distinctDefault >= 8, `default sliders keep variety (got ${distinctDefault} distinct genres, need ≥8)`);

// exclude works
{
  const t = new Taste();
  t.setSliders({ hardness: 0.3, speed: 0.5, darkness: 0.4, bounce: 0.6, psy: 1 });
  let repeats = 0;
  for (let i = 0; i < 300; i++) if (t.pick("psychedelic") === "psychedelic") repeats++;
  ok(repeats === 0, `pick(exclude) never returns the excluded genre (got ${repeats} repeats)`);
}

// ---- (b) per-genre composition distinctness ----
const clockStub = { ctx: {}, musicGain: {} };
const fingerprints = {};
let composeErrors = 0;
for (const genre of Object.keys(GENRES)) {
  try {
    const gm = new GenMusic(clockStub);
    const res = gm.compose(genre, 12345);
    const ev = gm._events;
    const hist = {};
    for (const e of ev) hist[e.type] = (hist[e.type] || 0) + 1;
    // kick fingerprint: kick offsets within the first drop bar (fractions of bar)
    const firstDrop = res.map.drops[0];
    const bar = 60 / res.bpm * 4;
    const kicksBar = ev.filter((e) => e.type === "kick" && e.t >= firstDrop + bar && e.t < firstDrop + 2 * bar)
      .map((e) => Math.round((e.t - firstDrop - bar) / bar * 16) / 16).sort();
    fingerprints[genre] = {
      bpm: res.bpm,
      dur: Math.round(res.durationSec),
      kicks: kicksBar.join(","),
      hist: JSON.stringify(Object.fromEntries(Object.entries(hist).sort())),
      sections: res.map.sections.map((s) => s.name).join(">"),
      notes: res.map.notes.length,
      drops: res.map.drops.length
    };
    if (!res.map.notes.length || res.map.drops.length < 2) composeErrors++;
  } catch (e) {
    composeErrors++;
    console.log("  compose EXCEPTION for " + genre + ": " + e.message);
  }
}
ok(composeErrors === 0, "all 20 genres compose without errors, with notes and ≥2 drops");

// pairwise distinctness of previously identical families
const pairsToCheck = [
  ["psytrance", "psychedelic"], ["psychedelic", "forestpsy"], ["psytrance", "forestpsy"],
  ["tribe", "hardtek"], ["hardtek", "raggatek"], ["tribe", "raggatek"],
  ["hardcore", "gabber"], ["gabber", "industrialhardcore"], ["hardcore", "industrialhardcore"],
  ["hardtechno", "industrialtechno"], ["hardstyle", "classichardstyle"],
  ["terror", "industrialhardcore"], ["crossbreed", "hardcore"], ["doomcore", "industrialtechno"],
  ["uptempo", "terror"], ["zaag", "rawstyle"], ["frenchcore", "hardstyle"]
];
let indistinct = [];
for (const [a, b] of pairsToCheck) {
  const A = fingerprints[a], B = fingerprints[b];
  const differs = A.bpm !== B.bpm || A.kicks !== B.kicks || A.hist !== B.hist || A.sections !== B.sections;
  if (!differs) indistinct.push(a + "≈" + b);
}
ok(indistinct.length === 0, "all previously-identical genre pairs now compose distinctly" + (indistinct.length ? " (still same: " + indistinct.join(", ") + ")" : ""));

// same genre, two seeds → different riffs but same identity
{
  const gm1 = new GenMusic(clockStub), gm2 = new GenMusic(clockStub);
  gm1.compose("psytrance", 1); gm2.compose("psytrance", 2);
  const leads1 = gm1._events.filter((e) => e.type === "lead").map((e) => Math.round(e.f)).join(",");
  const leads2 = gm2._events.filter((e) => e.type === "lead").map((e) => Math.round(e.f)).join(",");
  ok(leads1 !== leads2, "different seeds → different melodies within a genre");
}

// radio plan is shorter
{
  const gm1 = new GenMusic(clockStub), gm2 = new GenMusic(clockStub);
  const full = gm1.compose("hardstyle", 7);
  const radio = gm2.compose("hardstyle", 7, { plan: "radio" });
  ok(radio.durationSec < full.durationSec * 0.7, `radio plan is shorter (${Math.round(radio.durationSec)}s vs ${Math.round(full.durationSec)}s)`);
}

// kick patterns actually differ where configured
{
  const four = kickBeatsFor(void 0, 3, true).map((k) => k.b).join(",");
  const doom = kickBeatsFor("halfdoom", 3, true).map((k) => k.b).join(",");
  const broken = kickBeatsFor("brokenstomp", 3, true).map((k) => k.b).join(",");
  ok(four !== doom && four !== broken && doom !== broken, "kick pattern archetypes differ");
}

// ---- (c) bundled-track fallback ----
const btStart = bundle.indexOf("var BUNDLED_TRACKS = {");
const btEnd = bundle.indexOf("};", btStart) + 2;
vm.runInContext(bundle.slice(btStart, btEnd), sandbox);
const BT = sandbox.BUNDLED_TRACKS;
ok(!!BT.psychedelic && !!BT.industrialhardcore && !!BT.industrialtechno, "new tracks registered in BUNDLED_TRACKS");
ok(!bundle.includes('BUNDLED_TRACKS[mode === "origins" ? "hardcore" : "hardstyle"]'), "wrong-genre fallback removed from startForge");
const withFiles = Object.keys(BT);
const withoutFiles = Object.keys(GENRES).filter((g) => !withFiles.includes(g));
console.log("  genres with real tracks (" + withFiles.length + "): " + withFiles.join(", "));
console.log("  genres on procedural engine (" + withoutFiles.length + "): " + withoutFiles.join(", "));
ok(withFiles.every((g) => GENRES[g]), "every bundled track maps to a real genre");

// jukebox: retune + private bus present
ok(bundle.includes("_retune()") && bundle.includes("this._bus.connect(clock.musicGain)"), "jukebox has live retune + private radio bus");
ok(bundle.includes('this.gen.compose(genre, void 0, { plan: "radio" })'), "jukebox composes radio-length arrangements");

// fingerprint table for the docs
console.log("\nGenre fingerprint table (seed 12345):");
for (const [g, f] of Object.entries(fingerprints)) {
  console.log(`  ${g.padEnd(19)} ${String(f.bpm).padStart(3)} BPM  ${String(f.dur).padStart(3)}s  kicks[drop-bar]: ${f.kicks}`);
}

console.log(failures.length ? `\n${failures.length} FAILURES` : "\nALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
