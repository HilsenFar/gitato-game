// GITATO COMMAND — replays: record the per-tick command stream, play it back
// through the deterministic sim. A replay is { seed, log } plus version tags;
// the AI is never re-run on playback — its commands are part of the log.
// This module touches no DOM/storage at load time so the Node test harness
// can eval it alongside the sim.
'use strict';

RTS.replay = (() => {
  const C = RTS.C;
  const FMT = 1;
  const STORE_KEY = 'rts-last-replay';

  // stable hash (djb2) of every table the SIM reads. AI tables are excluded on
  // purpose: AI commands are recorded, so AI tuning cannot desync a replay.
  function balHash() {
    const src = JSON.stringify([RTS.C, RTS.KINDS, RTS.PROJ_SPEED, RTS.VET, RTS.TECH, RTS.TURRET_UP]);
    let h = 5381;
    for (let i = 0; i < src.length; i++) h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;
    return h;
  }

  let rec = null;   // active recording: { seed, mode, diff, log }
  let play = null;  // active playback: { rep, i }

  // ---- recording (host / skirmish only — the client never simulates) ----
  function begin(mode, seed, diff) {
    rec = { seed, mode, diff: diff || null, log: [] };
  }
  function record(tick, cmds) {
    if (!rec || !cmds.length) return;
    rec.log.push([tick, cmds]);
  }
  // winner: 0/1/2(draw); reason: 'over' | 'disconnect'
  function finish(winner, endTick, reason) {
    if (!rec) return null;
    const rep = {
      fmt: FMT, game: 'gitato-command', wire: C.ROOM_PREFIX, bal: balHash(),
      seed: rec.seed, mode: rec.mode, diff: rec.diff,
      winner, endTick, reason: reason || 'over',
      log: rec.log,
    };
    rec = null;
    return rep;
  }
  const abort = () => { rec = null; };
  const recording = () => !!rec;

  // ---- validation ----
  // returns the replay or null if the object is not a playable replay at all.
  // The log is checked structurally too: files and wire payloads are untrusted,
  // and a malformed entry would otherwise throw inside the 20 Hz loop.
  function validate(rep) {
    if (!rep || rep.game !== 'gitato-command' || rep.fmt !== FMT) return null;
    if (!Number.isFinite(rep.seed) || !Array.isArray(rep.log)) return null;
    if (rep.winner !== 0 && rep.winner !== 1 && rep.winner !== 2) return null;
    let prevTick = 0;
    for (const en of rep.log) {
      if (!Array.isArray(en) || !Number.isInteger(en[0]) || en[0] < prevTick || !Array.isArray(en[1])) return null;
      prevTick = en[0];
      for (const c of en[1]) {
        if (!c || typeof c !== 'object' || typeof c.c !== 'string') return null;
        if (c.ids !== undefined && !Array.isArray(c.ids)) return null;
        if (c.x !== undefined && typeof c.x !== 'number') return null;
        if (c.y !== undefined && typeof c.y !== 'number') return null;
        if (c.tid !== undefined && typeof c.tid !== 'number') return null;
        if (c.kind !== undefined && typeof c.kind !== 'string') return null;
        if (c.tech !== undefined && typeof c.tech !== 'string') return null;
        // build needs real coordinates — undefined slips past footprintFree
        // and would plant a phantom building at NaN
        if (c.c === 'build' && (!Number.isFinite(c.x) || !Number.isFinite(c.y))) return null;
      }
    }
    // endTick must be an integer within an hour of sim time (72 000 ticks)
    // after the last command — Infinity/1e15 would defeat every playback
    // termination path and leave the replay running forever
    if (!Number.isInteger(rep.endTick) || rep.endTick < 0 || rep.endTick > prevTick + 72000) return null;
    return rep;
  }
  // 'ok', or 'version' when recorded under another wire protocol / balance —
  // playback still runs, but may diverge (the drift check catches it)
  function compat(rep) {
    return rep.wire === C.ROOM_PREFIX && rep.bal === balHash() ? 'ok' : 'version';
  }

  // ---- last-game slot (localStorage may be unavailable or full) ----
  function storeLast(rep) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(rep)); return true; }
    catch (e) { return false; }
  }
  function loadLast() {
    try {
      const s = localStorage.getItem(STORE_KEY);
      return s ? validate(JSON.parse(s)) : null;
    } catch (e) { return null; }
  }

  function download(rep) {
    const blob = new Blob([JSON.stringify(rep)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gitato-command-replay-' + rep.seed + '-' + rep.endTick + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---- playback cursor ----
  function start(rep) { play = { rep, i: 0 }; }
  function stop() { play = null; }
  const playing = () => !!play;
  const current = () => (play ? play.rep : null);

  // commands recorded for this tick (log is tick-ordered; ticks are consumed
  // monotonically). p is re-clamped — a file is untrusted input.
  function cmdsFor(tick) {
    if (!play) return [];
    const log = play.rep.log;
    while (play.i < log.length && log[play.i][0] < tick) play.i++;
    const out = [];
    while (play.i < log.length && log[play.i][0] === tick) {
      for (const c of log[play.i][1]) {
        c.p = c.p === 1 ? 1 : 0;
        out.push(c);
      }
      play.i++;
    }
    return out;
  }

  return {
    begin, record, finish, abort, recording,
    validate, compat, storeLast, loadLast, download,
    start, stop, playing, current, cmdsFor, balHash,
  };
})();
