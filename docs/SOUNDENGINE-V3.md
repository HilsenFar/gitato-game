# Sound Engine v3 — every genre gets its own sound

**Date:** 2026-07-15 · **Scope:** `app.bundle.js`, `sw.js`, `assets/tracks/`, `tools/soundengine-v3/`

## The two bugs that were fixed

### 1. The game played the same file for 12 of 20 genres
`startForge()` contained:

```js
const bt = BUNDLED_TRACKS[genre] || BUNDLED_TRACKS[mode === "origins" ? "hardcore" : "hardstyle"];
```

Only 8 genres had a real track file, so **psychedelic, industrialhardcore,
industrialtechno, terror, crossbreed, doomcore, uptempo, zaag, frenchcore,
hardtek, raggatek and forestpsy all played `hardstyle_150.m4a`** (or
`hardcore_180.m4a` in ORIGINS) while the forge screen displayed the right
genre name. Fix: no cross-genre fallback — a genre without its own file now
falls through to the procedural engine composing the **correct** genre.
Three new real tracks were added (see below), so 11 genres now have files
and 9 run on the (now genre-distinct) procedural engine.

### 2. GITATO RADIO ignored what you chose
Three compounding causes, all fixed:

- **Near-flat picker:** `Taste._score` used `(1 - d/5)³` over 20 genres —
  measured: PSYCHEDELIC-slider at max gave the psy branch only ~25% of picks
  (~8% per genre, barely above the 5% uniform baseline). Now: per-vibe
  weighted distance (psy axis weighs 1.6× — it defines the branch) through
  `exp(-9·d)`. Measured after: **~77% psy-branch at psy-max**, ~76%
  industrial-branch at dark+hard-max, full 20-genre variety at defaults.
- **Sliders only applied at track end (~100-170 s later):** `setSliders` now
  retunes live — 350 ms debounce, then a 0.25 s crossfade on a private radio
  bus into the top-3-scoring genre. Skip stays tight too (top-5, never the
  genre you just skipped); the natural end-of-track advance keeps the wider
  weighted rotation with 6% on-vibe exploration.
- **Every genre composed the same skeleton:** same 64-bar plan, same chord
  loop `[0,5,2,6]`, same 4/4 kick, same riff templates. Psytrance vs
  psychedelic vs forestpsy differed **only in BPM** — literally the same
  track at three speeds. See v3 composer below.

## The v3 procedural composer

Each entry in `GENRES` now carries its own musical identity — all consumed
by `compose()`:

| Field | What it controls | Examples |
|---|---|---|
| `kickPat` | kick-drum pattern archetype | doomcore `halfdoom` (half-time), crossbreed `brokenstomp` (alternating broken bars), terror/uptempo `uptempo` (extra 8th kick), tek family `fourghost` (ghost kick) |
| `chords` | harmonic loop (scale degrees) | hardstyle `[0,5,3,4]` emotional, hardcore family `[0,1,0,6]` phrygian menace, psy `[0,0,0,0]` hypnotic static root, frenchcore `[0,3,4,5]` uplift |
| `plan` | arrangement archetype | `standard` 64 bars, `hypnotic` (psy/techno: long drops, short breaks), `raw` (gabber/terror: 2-bar intro, relentless), `doom` (long breaks, heavy pads) |
| `riffTpl`/`riffOct`/`riffDbl` | melodic fingerprint | psychedelic: straight-8 arp + 45% octave jumps; psytrance: 16th gallop velocity; industrialtechno: sparse dark acid |
| `snareOn` | backbeat snare | raggatek gets a skank backbeat on beat 3 instead of claps |
| `energy` | mix emphasis `{lead,bass,hats}` | gabber kick-forward, psy lead-forward, doomcore bass-heavy |
| `bass: "gallop"` | new triplet-gallop bass mode | frenchcore |

Sidechain ducking now scales with kick velocity so ghost kicks don't pump
the whole bus. The jukebox composes a `radio` plan variant (~55% length,
~54 s at 150 BPM) so the mix rotates faster.

## Three new real tracks (Higgsfield `sonilo_music`)

| File | Genre | Prompted BPM | Loop body | Length |
|---|---|---|---|---|
| `tracks/psychedelic_145.m4a` | psychedelic | 145 | 22.2 s | 74 s |
| `tracks/industrialhardcore_185.m4a` | industrialhardcore | 185 | 18.4 s | 85 s |
| `tracks/industrialtechno_135.m4a` | industrialtechno | 135 | 15.6 s | 77 s |

Pipeline: 30 s generation (1.88 credits each) → periodicity-grid loop
extension (`tools/soundengine-v3/looper4.py`): low-band onset envelope →
dominant period by autocorrelation → loop in/out points on STRONG on-grid
attacks with a **±1.5 s RMS-sustain requirement** (≥ median−5 dB) so a seam
can never sit next to a breakdown → body length = multiple of 8 pulses →
8 ms equal-power microfades exactly on kick attacks. Loudness matched to the
existing tracks (−11 to −12.6 dB mean vs −12.0 to −12.5), AAC 300 kbps 44.1 kHz.

Verified with the game's own `analyzeFile` beat detector: grid-hit-rates
0.943–0.995 — equal to or better than the previously shipped tracks
(0.967–0.994).

## Detours taken (documented per house rule)

1. **No source repo exists** — the repo ships only the esbuild bundle
   (`app.bundle.js`, unminified). All engine changes were made directly in
   the bundle; section markers (`// renderer/js/engine/…`) keep it navigable.
   If the original `renderer/js/` source tree still exists somewhere, port
   these changes there before the next bundle build.
2. **BPM detection is genuinely ambiguous** on these tracks — four
   independent estimators (python autocorr, inter-kick intervals, the game's
   analyzeFile, the label BPM) disagreed by ×2/3, ×3/2 factors. Resolution:
   don't trust ANY absolute BPM for looping; splice on onset-aligned exact
   multiples of the measured dominant period instead (BPM-independent), and
   treat the game's own detector as the only authority that matters for
   gameplay. Note: the pre-existing shipped tracks also detect off-label
   (hardstyle_150 → 144.1), so this was always the case.
3. **First loop attempt rejected by verification** — naive whole-bar tiling
   left a −38 dB hole right after the industrialtechno seams (the raw clip
   has a near-silent break at 7.5–8.3 s). This is why looper4 has the
   RMS-sustain constraint. Seam QA: onset-interval continuity + windowed RMS
   (±1 dB across every final seam).
4. **Credit budget:** 10.45 credits available; a 60 s track costs 3.75, so
   12 missing genres × 60 s (45 cr) was impossible. Spent 5.64 on 3×30 s for
   the exact subgenres reported broken; the other 9 genres are covered by
   the v3 procedural engine. ~4.8 credits remain as regeneration buffer.

## Verification (all green)

- `tools/soundengine-v3/verify_logic.mjs` — extracts the modified sections
  from the bundle: picker steering (psy ≥60%: got 77%), 20/20 genres compose
  distinctly (all previously-identical pairs now differ), radio plan shorter,
  fallback removed, tracks registered.
- `tools/soundengine-v3/verify_browser.mjs` — headless Chromium: boots clean;
  radio starts, retunes to psy on slider move, 7/8 skips stay on-vibe, no
  back-to-back repeats; ASCEND fetches `psychedelic_145.m4a` /
  `industrialhardcore_185.m4a` for those genres, NO file for terror
  (procedural), `hardstyle_150.m4a` for hardstyle; ORIGINS frenchcore no
  longer hijacks hardcore's file.
- Service worker cache bumped `gitato-game-v7 → v8` so live players heal on
  next visit.

Run them: `cd tools/soundengine-v3 && npm i playwright && node verify_logic.mjs && node verify_browser.mjs`
(both expect to run from this folder, game served from the repo root).
