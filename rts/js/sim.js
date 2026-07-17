// GITATO COMMAND — authoritative simulation (runs on the host / in skirmish)
'use strict';

RTS.sim = (() => {
  const C = RTS.C, K = RTS.KINDS, KL = RTS.KIND_LIST, U = RTS.util, M = RTS.map;
  const T = C.TILE;

  function init(seed) {
    const map = M.generate(seed);
    const s = {
      tick: 0,
      map,
      block: new Uint8Array(map.W * map.H),
      ents: [],
      byId: new Map(),
      nextId: 1,
      res: [C.START_CRYSTALS, C.START_CRYSTALS],
      over: -1,          // -1 running, 0/1 winner, 2 draw
      evs: [],
    };
    for (let i = 0; i < map.rock.length; i++) if (map.rock[i]) s.block[i] = M.ROCK;

    for (const c of map.crystals) {
      const e = spawn(s, 'crystal', 2, (c.tx + 0.5) * T, (c.ty + 0.5) * T);
      e.hp = e.maxhp = C.CRYSTAL_AMOUNT;
      s.block[c.ty * map.W + c.tx] = M.CRYS;
    }

    for (let p = 0; p < 2; p++) {
      const st = map.starts[p];
      const hq = placeBuilding(s, 'hq', p, st.tx - 1, st.ty - 1);
      hq.prog = 1; hq.hp = hq.maxhp;
      setDefaultRally(s, hq);
      for (let i = 0; i < C.START_WORKERS; i++) {
        const w = spawn(s, 'worker', p, hq.x - T * 1.5 + i * 18, hq.y + T * 2.2);
        orderHarvestNearest(s, w);
      }
    }
    return s;
  }

  function spawn(s, kind, owner, x, y) {
    const k = K[kind];
    const e = {
      id: s.nextId++, kind, owner, x, y,
      hp: k.hp, maxhp: k.hp, face: 0, flash: 0,
    };
    if (k.unit) {
      Object.assign(e, {
        state: 'idle', path: null, pi: 0, tx: x, ty: y,
        targetId: 0, amx: 0, amy: 0, carry: 0, ht: 0, cd: 0,
        crysId: 0, buildId: 0, stuck: 0, lastX: x, lastY: y,
      });
    }
    if (k.bld) {
      Object.assign(e, {
        prog: 0, queue: [], rallyX: x, rallyY: y + T * 2, rallyTid: 0, cd: 0, targetId: 0,
      });
    }
    s.ents.push(e);
    s.byId.set(e.id, e);
    return e;
  }

  // ---- building placement (footprint top-left in tile coords) ----
  function footprintFree(s, kind, tx, ty) {
    const k = K[kind], W = s.map.W, H = s.map.H;
    if (tx < 0 || ty < 0 || tx + k.fw > W || ty + k.fh > H) return false;
    for (let y = ty; y < ty + k.fh; y++)
      for (let x = tx; x < tx + k.fw; x++)
        if (s.block[y * W + x]) return false;
    return true;
  }

  function placeBuilding(s, kind, owner, tx, ty) {
    const k = K[kind], W = s.map.W;
    const e = spawn(s, kind, owner, (tx + k.fw / 2) * T, (ty + k.fh / 2) * T);
    e.ftx = tx; e.fty = ty;
    e.hp = Math.max(1, Math.round(k.hp * 0.1));
    for (let y = ty; y < ty + k.fh; y++)
      for (let x = tx; x < tx + k.fw; x++)
        s.block[y * W + x] = M.BLD;
    return e;
  }

  function unblockBuilding(s, e) {
    const k = K[e.kind], W = s.map.W;
    for (let y = e.fty; y < e.fty + k.fh; y++)
      for (let x = e.ftx; x < e.ftx + k.fw; x++)
        if (s.block[y * W + x] === M.BLD) s.block[y * W + x] = M.FREE;
  }

  function findBuildSpot(s, kind, nearTx, nearTy, maxR) {
    for (let r = 2; r <= (maxR || 14); r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = nearTx + dx, ty = nearTy + dy;
        if (footprintFree(s, kind, tx, ty)) return { tx, ty };
      }
    }
    return null;
  }

  // ---- pathing helpers ----
  function setPath(s, e, wx, wy) {
    const path = M.findPath(s.block, s.map.W, s.map.H,
      (e.x / T) | 0, (e.y / T) | 0, (wx / T) | 0, (wy / T) | 0);
    e.path = path ? path.map((p) => ({ x: (p.x + 0.5) * T, y: (p.y + 0.5) * T })) : null;
    if (e.path && e.path.length) {
      // final leg heads at the exact click point if it is in the same tile
      const last = e.path[e.path.length - 1];
      if (Math.abs(last.x - wx) < T && Math.abs(last.y - wy) < T && !s.block[((wy / T) | 0) * s.map.W + ((wx / T) | 0)]) {
        last.x = wx; last.y = wy;
      }
    }
    e.pi = 0; e.tx = wx; e.ty = wy; e.stuck = 0;
  }

  function pathToEntity(s, e, target) { setPath(s, e, target.x, target.y); }

  function nearestEnt(s, x, y, pred, maxD) {
    let best = null, bd = (maxD || 1e9) * (maxD || 1e9);
    for (const o of s.ents) {
      if (!pred(o)) continue;
      const d = U.dist2(x, y, o.x, o.y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  function orderHarvestNearest(s, w) {
    const c = nearestEnt(s, w.x, w.y, (o) => o.kind === 'crystal', 20 * T);
    if (c) { w.state = 'harvest'; w.crysId = c.id; w.targetId = 0; pathToEntity(s, w, c); }
  }

  function setDefaultRally(s, b) {
    if (b.kind === 'hq') {
      const c = nearestEnt(s, b.x, b.y, (o) => o.kind === 'crystal', 16 * T);
      if (c) { b.rallyTid = c.id; b.rallyX = c.x; b.rallyY = c.y; return; }
    }
    b.rallyTid = 0;
    const down = b.owner === 0 ? 1 : -1;
    b.rallyX = b.x; b.rallyY = b.y + down * T * 3;
  }

  // ---- commands ----
  // cmd: { p, c, ids, x, y, kind, tid }
  function applyCmd(s, cmd) {
    if (s.over !== -1) return;
    const mine = (id) => {
      const e = s.byId.get(id);
      return e && e.owner === cmd.p ? e : null;
    };
    switch (cmd.c) {
      case 'move': case 'amove': {
        const list = (cmd.ids || []).map(mine).filter((e) => e && K[e.kind].unit);
        spreadMove(s, list, cmd.x, cmd.y, cmd.c);
        break;
      }
      case 'stop': {
        for (const id of cmd.ids || []) {
          const e = mine(id);
          if (e && K[e.kind].unit) { e.state = 'idle'; e.path = null; e.targetId = 0; }
        }
        break;
      }
      case 'attack': {
        const t = s.byId.get(cmd.tid);
        if (!t || t.owner === cmd.p || t.kind === 'crystal') break;
        for (const id of cmd.ids || []) {
          const e = mine(id);
          if (e && K[e.kind].unit) { e.state = 'attack'; e.targetId = t.id; e.amx = 0; e.amy = 0; pathToEntity(s, e, t); }
        }
        break;
      }
      case 'harvest': {
        const t = s.byId.get(cmd.tid);
        if (!t || t.kind !== 'crystal') break;
        for (const id of cmd.ids || []) {
          const e = mine(id);
          if (e && e.kind === 'worker') { e.state = 'harvest'; e.crysId = t.id; e.targetId = 0; pathToEntity(s, e, t); }
        }
        break;
      }
      case 'build': {
        // one worker places a new site (crystals deducted now)
        const e = mine((cmd.ids || [])[0]);
        const k = K[cmd.kind];
        if (!e || e.kind !== 'worker' || !k || !k.bld) break;
        if (s.res[cmd.p] < k.cost || !footprintFree(s, cmd.kind, cmd.x, cmd.y)) break;
        s.res[cmd.p] -= k.cost;
        const b = placeBuilding(s, cmd.kind, cmd.p, cmd.x, cmd.y);
        e.state = 'tobuild'; e.buildId = b.id; e.targetId = 0;
        pathToEntity(s, e, b);
        break;
      }
      case 'repair': { // send workers to finish an unfinished friendly site
        const t = s.byId.get(cmd.tid);
        if (!t || t.owner !== cmd.p || !K[t.kind].bld || t.prog >= 1) break;
        for (const id of cmd.ids || []) {
          const e = mine(id);
          if (e && e.kind === 'worker') { e.state = 'tobuild'; e.buildId = t.id; pathToEntity(s, e, t); }
        }
        break;
      }
      case 'train': {
        const b = mine(cmd.tid);
        const k = b && K[b.kind];
        if (!b || !k || !k.bld || b.prog < 1) break;
        if (!k.trains || !k.trains.includes(cmd.kind)) break;
        if (b.queue.length >= 5) break;
        const uk = K[cmd.kind];
        if (s.res[cmd.p] < uk.cost) break;
        s.res[cmd.p] -= uk.cost;
        b.queue.push({ kind: cmd.kind, t: uk.trainT });
        break;
      }
      case 'rally': {
        for (const id of cmd.ids || []) {
          const b = mine(id);
          if (!b || !K[b.kind].bld) continue;
          const t = cmd.tid ? s.byId.get(cmd.tid) : null;
          if (t && t.kind === 'crystal') { b.rallyTid = t.id; b.rallyX = t.x; b.rallyY = t.y; }
          else { b.rallyTid = 0; b.rallyX = cmd.x; b.rallyY = cmd.y; }
        }
        break;
      }
    }
  }

  // spread group targets in a loose ring so units don't fight for one spot
  function spreadMove(s, list, x, y, mode) {
    list.forEach((e, i) => {
      const ang = (i / Math.max(1, list.length)) * Math.PI * 2;
      const rad = i === 0 ? 0 : T * 0.7 * (1 + (i / 8));
      const px = x + Math.cos(ang) * rad, py = y + Math.sin(ang) * rad;
      e.targetId = 0;
      if (mode === 'amove') { e.state = 'amove'; e.amx = px; e.amy = py; }
      else e.state = 'move';
      setPath(s, e, px, py);
    });
  }

  // ---- per-tick update ----
  function step(s, cmds) {
    if (s.over !== -1) return;
    for (const c of cmds) applyCmd(s, c);
    const dt = C.DT;
    s.tick++;

    // buildings: construction handled via assigned workers; production queues
    for (const e of s.ents) {
      if (!K[e.kind].bld) continue;
      if (e.prog >= 1) {
        stepProduction(s, e, dt);
        if (K[e.kind].rng) stepTurret(s, e, dt);
      }
      if (e.flash > 0) e.flash -= dt;
    }

    // units
    for (const e of s.ents) {
      if (!K[e.kind].unit) continue;
      stepUnit(s, e, dt);
      if (e.flash > 0) e.flash -= dt;
    }

    if (s.tick % 5 === 0) acquireTargets(s);
    separate(s);
    stepProjectiles(s, dt);
    reap(s);
    checkOver(s);
  }

  function supply(s, p) {
    let n = 0;
    for (const e of s.ents) if (e.owner === p && K[e.kind].unit) n++;
    return n;
  }

  function stepProduction(s, b, dt) {
    if (!b.queue.length) return;
    const q = b.queue[0];
    if (q.t > 0) { q.t -= dt; return; }
    if (supply(s, b.owner) >= C.UNIT_CAP) return; // hold until space frees up
    const spot = M.nearestFree(s.block, s.map.W, s.map.H,
      b.ftx + ((K[b.kind].fw / 2) | 0), b.fty + K[b.kind].fh, 6);
    if (!spot) return;
    b.queue.shift();
    const u = spawn(s, q.kind, b.owner, (spot.x + 0.5) * T, (spot.y + 0.5) * T);
    const rt = b.rallyTid ? s.byId.get(b.rallyTid) : null;
    if (u.kind === 'worker' && rt && rt.kind === 'crystal') {
      u.state = 'harvest'; u.crysId = rt.id; pathToEntity(s, u, rt);
    } else if (u.kind === 'worker' && b.rallyTid) {
      orderHarvestNearest(s, u);
    } else {
      u.state = 'move'; setPath(s, u, b.rallyX, b.rallyY);
    }
  }

  function stepTurret(s, b, dt) {
    const k = K[b.kind];
    b.cd = Math.max(0, b.cd - dt);
    let t = b.targetId ? s.byId.get(b.targetId) : null;
    if (t && (t.hp <= 0 || U.dist2(b.x, b.y, t.x, t.y) > k.rng * k.rng * 1.4)) { t = null; b.targetId = 0; }
    if (!t) return;
    if (U.dist2(b.x, b.y, t.x, t.y) <= k.rng * k.rng && b.cd <= 0) {
      b.cd = k.cd; b.flash = 0.12;
      fireProjectile(s, b, t, k);
    }
  }

  function stepUnit(s, e, dt) {
    const k = K[e.kind];
    e.cd = Math.max(0, e.cd - dt);

    switch (e.state) {
      case 'idle': break;
      case 'move':
        if (followPath(s, e, k, dt)) e.state = 'idle';
        break;
      case 'amove': {
        if (e.targetId) { attackStep(s, e, k, dt, 'amove'); break; }
        if (followPath(s, e, k, dt)) e.state = 'idle';
        break;
      }
      case 'attack':
        attackStep(s, e, k, dt, 'idle');
        break;
      case 'harvest': harvestStep(s, e, k, dt); break;
      case 'return': returnStep(s, e, k, dt); break;
      case 'tobuild': buildStep(s, e, k, dt); break;
    }
  }

  function attackStep(s, e, k, dt, fallback) {
    const t = e.targetId ? s.byId.get(e.targetId) : null;
    if (!t || t.hp <= 0) {
      e.targetId = 0; e.path = null;
      if (fallback === 'amove' && (e.amx || e.amy)) { e.state = 'amove'; setPath(s, e, e.amx, e.amy); }
      else e.state = 'idle';
      return;
    }
    const d = U.dist(e.x, e.y, t.x, t.y);
    const reach = k.rng + (K[t.kind].r || tRadius(t));
    if (k.minRng && d < k.minRng) { // mortars back away
      const ang = Math.atan2(e.y - t.y, e.x - t.x);
      moveRaw(s, e, k, dt, e.x + Math.cos(ang) * T, e.y + Math.sin(ang) * T);
      return;
    }
    if (d > reach) {
      // chase; repath when the target strays from our path end
      if (!e.path || U.dist2(e.tx, e.ty, t.x, t.y) > (T * 2) * (T * 2)) pathToEntity(s, e, t);
      followPath(s, e, k, dt);
      return;
    }
    e.path = null;
    e.face = Math.atan2(t.y - e.y, t.x - e.x);
    if (e.cd <= 0) {
      e.cd = k.cd; e.flash = 0.12;
      if (k.proj) fireProjectile(s, e, t, k);
      else { damage(s, t, k.dmg, e.owner); s.evs.push([RTS.EV.HIT, t.x | 0, t.y | 0]); }
    }
  }

  function tRadius(t) {
    const k = K[t.kind];
    return k.bld ? Math.max(k.fw, k.fh) * T * 0.5 : (k.r || 10);
  }

  function fireProjectile(s, from, target, k) {
    s.projs = s.projs || [];
    s.projs.push({
      x: from.x, y: from.y, tid: target.id, tx: target.x, ty: target.y,
      spd: RTS.PROJ_SPEED[k.proj], dmg: k.dmg, splash: k.splash || 0,
      owner: from.owner, kind: k.proj,
    });
    s.evs.push([RTS.EV.SHOT, from.x | 0, from.y | 0]);
  }

  function harvestStep(s, e, k, dt) {
    const c = e.crysId ? s.byId.get(e.crysId) : null;
    if (!c || c.hp <= 0) {
      const alt = nearestEnt(s, e.x, e.y, (o) => o.kind === 'crystal', 12 * T);
      if (alt) { e.crysId = alt.id; pathToEntity(s, e, alt); }
      else { e.state = 'idle'; e.crysId = 0; }
      return;
    }
    const d = U.dist(e.x, e.y, c.x, c.y);
    if (d > T * 1.25) {
      if (!e.path) pathToEntity(s, e, c);
      if (followPath(s, e, k, dt) && U.dist(e.x, e.y, c.x, c.y) > T * 1.6) pathToEntity(s, e, c);
      return;
    }
    e.path = null;
    e.face = Math.atan2(c.y - e.y, c.x - e.x);
    e.ht += dt;
    if (e.ht >= C.HARVEST_TIME) {
      e.ht = 0;
      const take = Math.min(C.CARRY, c.hp);
      c.hp -= take;
      e.carry = take;
      if (c.hp <= 0) crystalDepleted(s, c);
      e.state = 'return';
      const hq = nearestEnt(s, e.x, e.y, (o) => o.owner === e.owner && o.kind === 'hq' && o.prog >= 1);
      if (hq) pathToEntity(s, e, hq); else e.state = 'idle';
    }
  }

  function returnStep(s, e, k, dt) {
    const hq = nearestEnt(s, e.x, e.y, (o) => o.owner === e.owner && o.kind === 'hq' && o.prog >= 1);
    if (!hq) { e.state = 'idle'; return; }
    if (U.dist(e.x, e.y, hq.x, hq.y) <= T * 2.4) {
      s.res[e.owner] += e.carry;
      e.carry = 0;
      s.evs.push([RTS.EV.DEPOSIT, hq.x | 0, hq.y | 0]);
      const c = e.crysId ? s.byId.get(e.crysId) : null;
      if (c && c.hp > 0) { e.state = 'harvest'; pathToEntity(s, e, c); }
      else { e.state = 'harvest'; harvestStep(s, e, k, dt); }
      return;
    }
    if (!e.path) pathToEntity(s, e, hq);
    followPath(s, e, k, dt);
  }

  function buildStep(s, e, k, dt) {
    const b = e.buildId ? s.byId.get(e.buildId) : null;
    if (!b || b.hp <= 0 || b.prog >= 1) { e.state = 'idle'; e.buildId = 0; return; }
    const bk = K[b.kind];
    const reach = Math.max(bk.fw, bk.fh) * T * 0.5 + T * 0.9;
    if (U.dist(e.x, e.y, b.x, b.y) > reach) {
      if (!e.path) pathToEntity(s, e, b);
      if (followPath(s, e, k, dt)) e.path = null;
      return;
    }
    e.path = null;
    e.face = Math.atan2(b.y - e.y, b.x - e.x);
    b.prog = Math.min(1, b.prog + dt / bk.buildT);
    b.hp = Math.min(b.maxhp, b.hp + (b.maxhp * 0.9) * (dt / bk.buildT));
    if (b.prog >= 1) {
      b.hp = b.maxhp;
      setDefaultRally(s, b);
      s.evs.push([RTS.EV.BUILT, b.x | 0, b.y | 0]);
      e.state = 'idle'; e.buildId = 0;
      if (e.kind === 'worker') orderHarvestNearest(s, e);
    }
  }

  function crystalDepleted(s, c) {
    const tx = (c.x / T) | 0, ty = (c.y / T) | 0;
    if (s.block[ty * s.map.W + tx] === M.CRYS) s.block[ty * s.map.W + tx] = M.FREE;
  }

  function moveRaw(s, e, k, dt, wx, wy) {
    const d = U.dist(e.x, e.y, wx, wy);
    if (d < 1) return true;
    const step = Math.min(d, k.spd * dt);
    e.face = Math.atan2(wy - e.y, wx - e.x);
    e.x += Math.cos(e.face) * step;
    e.y += Math.sin(e.face) * step;
    return d - step < 1;
  }

  function followPath(s, e, k, dt) {
    if (!e.path || e.pi >= e.path.length) { e.path = null; return true; }
    const wp = e.path[e.pi];
    if (moveRaw(s, e, k, dt, wp.x, wp.y)) {
      e.pi++;
      if (e.pi >= e.path.length) { e.path = null; return true; }
    }
    // stuck detection: barely moving for ~1.2 s → repath
    e.stuck += dt;
    if (e.stuck >= 1.2) {
      if (U.dist2(e.x, e.y, e.lastX, e.lastY) < 8 * 8) setPath(s, e, e.tx, e.ty);
      e.stuck = 0; e.lastX = e.x; e.lastY = e.y;
    }
    return false;
  }

  function acquireTargets(s) {
    for (const e of s.ents) {
      const k = K[e.kind];
      const aggro = k.aggro;
      if (!aggro) continue;
      if (k.unit && e.state !== 'idle' && e.state !== 'amove') continue;
      if (k.bld && e.prog < 1) continue;
      if (k.unit && e.targetId) continue;
      if (k.bld && e.targetId) continue;
      const t = nearestEnt(s, e.x, e.y,
        (o) => o.owner !== e.owner && o.owner < 2 && o.hp > 0, aggro);
      if (t) {
        e.targetId = t.id;
        if (k.unit && e.state === 'idle') { e.state = 'attack'; e.amx = 0; e.amy = 0; }
      }
    }
  }

  // soft collision: push overlapping units apart via a coarse spatial hash
  function separate(s) {
    const cell = 48, buckets = new Map();
    const units = [];
    for (const e of s.ents) {
      if (!K[e.kind].unit) continue;
      units.push(e);
      const key = ((e.x / cell) | 0) + ',' + ((e.y / cell) | 0);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(e);
    }
    for (const e of units) {
      const cx = (e.x / cell) | 0, cy = (e.y / cell) | 0;
      const r1 = K[e.kind].r;
      for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const b = buckets.get(gx + ',' + gy);
        if (!b) continue;
        for (const o of b) {
          if (o.id <= e.id) continue;
          const min = r1 + K[o.kind].r;
          const d2 = U.dist2(e.x, e.y, o.x, o.y);
          if (d2 >= min * min || d2 === 0) continue;
          const d = Math.sqrt(d2), push = (min - d) * 0.35;
          const nx = (e.x - o.x) / d, ny = (e.y - o.y) / d;
          e.x += nx * push; e.y += ny * push;
          o.x -= nx * push; o.y -= ny * push;
        }
      }
      // keep units off blocked tiles and inside the map
      const W = s.map.W, H = s.map.H;
      e.x = U.clamp(e.x, r1, W * T - r1);
      e.y = U.clamp(e.y, r1, H * T - r1);
      const ti = (((e.y / T) | 0) * W + ((e.x / T) | 0));
      if (s.block[ti]) {
        const f = M.nearestFree(s.block, W, H, (e.x / T) | 0, (e.y / T) | 0, 3);
        if (f) { e.x = (f.x + 0.5) * T; e.y = (f.y + 0.5) * T; }
      }
    }
  }

  function stepProjectiles(s, dt) {
    if (!s.projs) return;
    for (let i = s.projs.length - 1; i >= 0; i--) {
      const p = s.projs[i];
      const t = p.tid ? s.byId.get(p.tid) : null;
      if (t && t.hp > 0) { p.tx = t.x; p.ty = t.y; }
      const d = U.dist(p.x, p.y, p.tx, p.ty);
      const step = p.spd * dt;
      if (d <= step + 6) {
        // impact
        if (p.splash) {
          for (const o of s.ents) {
            if (o.owner === p.owner || o.owner > 1) continue;
            if (U.dist2(p.tx, p.ty, o.x, o.y) <= p.splash * p.splash) damage(s, o, p.dmg, p.owner);
          }
          s.evs.push([RTS.EV.BOOM, p.tx | 0, p.ty | 0]);
        } else {
          if (t && t.hp > 0) damage(s, t, p.dmg, p.owner);
          s.evs.push([RTS.EV.HIT, p.tx | 0, p.ty | 0]);
        }
        s.projs.splice(i, 1);
        continue;
      }
      const ang = Math.atan2(p.ty - p.y, p.tx - p.x);
      p.x += Math.cos(ang) * step;
      p.y += Math.sin(ang) * step;
    }
  }

  function damage(s, e, dmg, byOwner) {
    if (e.hp <= 0) return;
    e.hp -= dmg;
    e.lastHitTick = s.tick;
    e.lastHitBy = byOwner;
  }

  function reap(s) {
    for (let i = s.ents.length - 1; i >= 0; i--) {
      const e = s.ents[i];
      if (e.hp > 0) continue;
      if (e.kind === 'crystal') { crystalDepleted(s, e); }
      else if (K[e.kind].bld) {
        unblockBuilding(s, e);
        s.evs.push([RTS.EV.BIGBOOM, e.x | 0, e.y | 0]);
      } else {
        s.evs.push([RTS.EV.BOOM, e.x | 0, e.y | 0]);
      }
      s.byId.delete(e.id);
      s.ents.splice(i, 1);
    }
  }

  function checkOver(s) {
    if (s.over !== -1) return;
    const alive = [false, false];
    for (const e of s.ents) if (e.kind === 'hq' && e.owner < 2) alive[e.owner] = true;
    if (alive[0] && alive[1]) return;
    if (!alive[0] && !alive[1]) s.over = 2;
    else s.over = alive[0] ? 0 : 1;
  }

  // ---- compact snapshot for the wire / renderer ----
  // ent row: [id, kindIdx, owner, x, y, hp, faceDeg, flags, qlen, progPct, qKindIdx]
  // flags: 1 carrying, 2 constructing, 4 muzzle flash
  function snapshot(s) {
    const e = [];
    for (const o of s.ents) {
      const k = K[o.kind];
      let flags = 0, qlen = 0, prog = 0, qkind = 255;
      if (o.carry) flags |= 1;
      if (k.bld && o.prog < 1) { flags |= 2; prog = (o.prog * 100) | 0; }
      if (o.flash > 0) flags |= 4;
      if (k.bld && o.prog >= 1 && o.queue.length) {
        qlen = o.queue.length;
        const q = o.queue[0];
        prog = (100 - (q.t / K[q.kind].trainT) * 100) | 0;
        qkind = KL.indexOf(q.kind);
      }
      e.push([o.id, KL.indexOf(o.kind), o.owner, o.x | 0, o.y | 0, Math.ceil(o.hp),
        ((o.face * 180 / Math.PI) | 0) & 511, flags, qlen, prog, qkind]);
    }
    const p = (s.projs || []).map((pr) => [pr.x | 0, pr.y | 0, pr.kind === 'shell' ? 1 : 0]);
    const snap = {
      t: s.tick,
      res: [s.res[0] | 0, s.res[1] | 0],
      sup: [supply(s, 0), supply(s, 1)],
      over: s.over,
      e, p,
      v: s.evs,
    };
    s.evs = [];
    return snap;
  }

  return {
    init, step, snapshot, applyCmd, footprintFree, findBuildSpot,
    nearestEnt, supply,
  };
})();
