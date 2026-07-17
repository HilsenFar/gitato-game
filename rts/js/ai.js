// GITATO COMMAND — skirmish bot (runs on the host, plays like a client: emits commands)
'use strict';

RTS.ai = (() => {
  const C = RTS.C, K = RTS.KINDS, U = RTS.util;
  const T = C.TILE;

  function create(player) {
    return {
      p: player,
      wave: 8,          // army size that triggers the next attack
      lastDecision: 0,
      attackUntil: 0,   // tick until which the current push stays committed
    };
  }

  // called every tick on the host; returns a list of commands (usually empty)
  function think(ai, s) {
    if (s.over !== -1) return [];
    if (s.tick - ai.lastDecision < 20) return []; // decide once per second
    ai.lastDecision = s.tick;

    const cmds = [];
    const p = ai.p;
    const mine = s.ents.filter((e) => e.owner === p);
    const my = (kind) => mine.filter((e) => e.kind === kind);
    const built = (kind) => my(kind).filter((e) => e.prog >= 1);
    const hqs = built('hq');
    const hq = hqs[0];
    if (!hq) return cmds;

    const workers = my('worker');
    const army = mine.filter((e) => ['marine', 'brute', 'mortar'].includes(e.kind));
    const res = s.res[p];
    const enemyStart = s.map.starts[1 - p];
    const enemyHome = { x: (enemyStart.tx + 0.5) * T, y: (enemyStart.ty + 0.5) * T };

    // --- economy ---
    if (workers.length < 9 && res >= K.worker.cost && hq.queue.length < 2) {
      cmds.push({ p, c: 'train', tid: hq.id, kind: 'worker' });
    }
    for (const w of workers) {
      if (w.state === 'idle') cmds.push(harvestCmd(s, p, w));
    }

    // --- build order ---
    const wantBuild = (kind, cond) => {
      if (!cond || res < K[kind].cost) return false;
      const builder = workers.find((w) => ['idle', 'harvest', 'return'].includes(w.state));
      if (!builder) return false;
      const spot = RTS.sim.findBuildSpot(s, kind, hq.ftx + 1, hq.fty + 1, 12);
      if (!spot) return false;
      cmds.push({ p, c: 'build', ids: [builder.id], kind, x: spot.tx, y: spot.ty });
      return true;
    };
    const raxes = my('rax'), facts = my('fact'), turrets = my('turret');
    // resume any orphaned construction site
    const site = mine.find((e) => K[e.kind].bld && e.prog < 1 &&
      !workers.some((w) => w.buildId === e.id));
    if (site) {
      const w = workers.find((w2) => ['idle', 'harvest', 'return'].includes(w2.state));
      if (w) cmds.push({ p, c: 'repair', ids: [w.id], tid: site.id });
    } else if (!wantBuild('rax', raxes.length === 0)) {
      if (!wantBuild('turret', raxes.length > 0 && turrets.length < 2 && workers.length >= 6 && res >= 250)) {
        if (!wantBuild('fact', raxes.length > 0 && facts.length === 0 && workers.length >= 8 && res >= 300)) {
          wantBuild('rax', raxes.length === 1 && facts.length > 0 && res >= 450);
        }
      }
    }

    // --- army production ---
    for (const b of built('rax')) {
      if (b.queue.length >= 2) continue;
      const kind = (army.length % 3 === 2) ? 'brute' : 'marine';
      if (s.res[p] >= K[kind].cost + 50) cmds.push({ p, c: 'train', tid: b.id, kind });
    }
    for (const b of built('fact')) {
      if (b.queue.length >= 1) continue;
      if (s.res[p] >= K.mortar.cost + 100) cmds.push({ p, c: 'train', tid: b.id, kind: 'mortar' });
    }

    // --- defense: anything of mine hit recently? rally the army there ---
    const attacked = mine.find((e) => e.lastHitTick && s.tick - e.lastHitTick < 60 && K[e.kind].bld);
    if (attacked && s.tick > ai.attackUntil) {
      cmds.push({ p, c: 'amove', ids: army.map((e) => e.id), x: attacked.x, y: attacked.y });
      return cmds;
    }

    // --- attack waves ---
    if (army.length >= ai.wave && s.tick > ai.attackUntil) {
      const enemies = s.ents.filter((e) => e.owner === 1 - p && K[e.kind].bld);
      const target = enemies.length
        ? enemies.reduce((a, b2) => (U.dist2(hq.x, hq.y, a.x, a.y) < U.dist2(hq.x, hq.y, b2.x, b2.y) ? a : b2))
        : enemyHome;
      cmds.push({ p, c: 'amove', ids: army.map((e) => e.id), x: target.x, y: target.y });
      ai.wave = Math.min(24, ai.wave + 4);
      ai.attackUntil = s.tick + 20 * 45; // stay committed for 45 s
    }

    return cmds;
  }

  function harvestCmd(s, p, w) {
    const c = RTS.sim.nearestEnt(s, w.x, w.y, (o) => o.kind === 'crystal', 30 * T);
    if (c) return { p, c: 'harvest', ids: [w.id], tid: c.id };
    return { p, c: 'stop', ids: [w.id] };
  }

  return { create, think };
})();
