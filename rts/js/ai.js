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
      nextHarass: 0,    // tick when the next raider harass squad may launch
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
    const army = mine.filter((e) => ['marine', 'brute', 'mortar', 'raider'].includes(e.kind));
    const res = s.res[p];
    const enemyStart = s.map.starts[1 - p];
    const enemyHome = { x: (enemyStart.tx + 0.5) * T, y: (enemyStart.ty + 0.5) * T };

    // --- economy ---
    const wantWorkers = 9 + 4 * (hqs.length - 1);
    for (const h of hqs) {
      if (workers.length < wantWorkers && res >= K.worker.cost && h.queue.length < 2) {
        cmds.push({ p, c: 'train', tid: h.id, kind: 'worker' });
        break;
      }
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
    } else if (!tryExpand(s, ai, cmds, hqs, raxes, workers, res, my('hq'))) {
      if (!wantBuild('rax', raxes.length === 0)) {
        if (!wantBuild('turret', raxes.length > 0 && turrets.length < 2 && workers.length >= 6 && res >= 250)) {
          if (!wantBuild('fact', raxes.length > 0 && facts.length === 0 && workers.length >= 8 && res >= 300)) {
            wantBuild('rax', raxes.length === 1 && facts.length > 0 && res >= 450);
          }
        }
      }
    }

    // --- army production (mix scales with the economy) ---
    // factory first so tech units actually get made before the rax drains the bank
    const rich = res >= 500;
    let reserved = 0; // crystals promised to factory queues this decision
    for (const b of built('fact')) {
      if (b.queue.length >= (rich ? 2 : 1)) continue;
      // first two raiders come out fast (harass squad), then alternate with mortars
      const nR = my('raider').length, nM = my('mortar').length;
      const kind = (nR < 2 || nR <= nM) ? 'raider' : 'mortar';
      if (s.res[p] >= K[kind].cost) {
        cmds.push({ p, c: 'train', tid: b.id, kind });
        reserved += K[kind].cost;
      }
    }
    for (const b of built('rax')) {
      if (b.queue.length >= (rich ? 3 : 2)) continue;
      const kind = (army.length % 3 === 2) ? 'brute' : 'marine';
      if (s.res[p] - reserved >= K[kind].cost + 50) cmds.push({ p, c: 'train', tid: b.id, kind });
    }

    // --- defense: anything of mine hit recently? rally the army there ---
    const attacked = mine.find((e) => e.lastHitTick && s.tick - e.lastHitTick < 60 && K[e.kind].bld);
    if (attacked && s.tick > ai.attackUntil) {
      cmds.push({ p, c: 'amove', ids: army.map((e) => e.id), x: attacked.x, y: attacked.y });
      return cmds;
    }

    // --- raider harass: hit the enemy worker line once the factory is up ---
    const raiders = my('raider');
    if (facts.some((f) => f.prog >= 1) && raiders.length >= 2 && s.tick >= ai.nextHarass) {
      const squad = raiders.slice(0, RTS.AI.harassSize); // 2-3 raiders
      const ew = s.ents.filter((e) => e.owner === 1 - p && e.kind === 'worker');
      const tgt = ew.length
        ? ew.reduce((a, b2) => (U.dist2(enemyHome.x, enemyHome.y, a.x, a.y) < U.dist2(enemyHome.x, enemyHome.y, b2.x, b2.y) ? a : b2))
        : enemyHome;
      cmds.push({ p, c: 'amove', ids: squad.map((e) => e.id), x: tgt.x, y: tgt.y });
      ai.nextHarass = s.tick + 20 * 45; // one squad every 45 s at most
    }

    // --- attack waves ---
    // stall-breaker: if no push has launched for ~3 min, attack with what we have
    const overdue = army.length >= 6 && s.tick > ai.attackUntil + 20 * 180;
    if ((army.length >= ai.wave || overdue) && s.tick > ai.attackUntil) {
      const enemies = s.ents.filter((e) => e.owner === 1 - p && K[e.kind].bld);
      const target = enemies.length
        ? enemies.reduce((a, b2) => (U.dist2(hq.x, hq.y, a.x, a.y) < U.dist2(hq.x, hq.y, b2.x, b2.y) ? a : b2))
        : enemyHome;
      cmds.push({ p, c: 'amove', ids: army.map((e) => e.id), x: target.x, y: target.y });
      ai.wave = Math.min(RTS.AI.waveCap, ai.wave + 4);
      ai.attackUntil = s.tick + 20 * 45; // stay committed for 45 s
    }

    return cmds;
  }

  // expansion: when the crystals near our HQs run dry, plant a new HQ at the
  // nearest untapped cluster (workers migrate on their own via harvest search)
  function tryExpand(s, ai, cmds, hqs, raxes, workers, res, allHqs) {
    const p = ai.p;
    if (!raxes.length || allHqs.length >= 3 || allHqs.some((h) => h.prog < 1) || res < K.hq.cost) return false;
    const NEAR = 14 * T;
    const nearHq = (o) => hqs.some((h) => U.dist2(h.x, h.y, o.x, o.y) < NEAR * NEAR);
    let nearLeft = 0;
    for (const e of s.ents) if (e.kind === 'crystal' && nearHq(e)) nearLeft += e.hp;
    if (nearLeft >= RTS.AI.expandAt) return false;
    const far = RTS.sim.nearestEnt(s, hqs[0].x, hqs[0].y,
      (o) => o.kind === 'crystal' && o.hp > 0 && !nearHq(o), 1e9);
    if (!far) return false;
    const spot = RTS.sim.findBuildSpot(s, 'hq', (far.x / T) | 0, (far.y / T) | 0, 8);
    const builder = workers.find((w) => ['idle', 'harvest', 'return'].includes(w.state));
    if (!spot || !builder) return false;
    cmds.push({ p, c: 'build', ids: [builder.id], kind: 'hq', x: spot.tx, y: spot.ty });
    return true;
  }

  function harvestCmd(s, p, w) {
    // unbounded search so workers migrate to the expansion when home runs dry
    const c = RTS.sim.nearestEnt(s, w.x, w.y, (o) => o.kind === 'crystal', 1e9);
    if (c) return { p, c: 'harvest', ids: [w.id], tid: c.id };
    return { p, c: 'stop', ids: [w.id] };
  }

  return { create, think };
})();
