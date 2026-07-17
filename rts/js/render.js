// GITATO COMMAND — view layer: snapshot interpolation, fog of war, overlay HUD, minimap.
// World rendering is delegated to scene3d (Three.js); this module draws the
// transparent 2D overlay (health bars, particles, drag rect) and the minimap.
'use strict';

RTS.render = (() => {
  const C = RTS.C, K = RTS.KINDS, KL = RTS.KIND_LIST, U = RTS.util;
  const T = C.TILE, EV = RTS.EV;

  let cv, ctx, mmCv, mmCtx;
  let map = null;
  let terrain = null;        // procedural ground canvas (used as the 3D ground texture)
  let mmTerrain = null;      // cached minimap ground
  let fog = null;            // Uint8Array per tile: 0 unseen, 1 explored, 2 visible
  let fogCv = null, fogCtx = null;
  let myPlayer = 0;
  let particles = [];
  let lastFrame = 0;

  // interpolation buffer
  const view = {
    prev: null, next: null, tNext: 0, dtSnap: 100,
    push(snap) {
      const now = performance.now();
      if (this.next) this.dtSnap = U.clamp(now - this.tNext, 40, 400);
      this.prev = this.next;
      this.next = snap;
      this.tNext = now;
      if (map) updateFog(snap);
      for (const ev of snap.v || []) onEvent(ev);
    },
    reset() { this.prev = null; this.next = null; },
  };

  function initCanvas(canvas, minimap, glCanvas) {
    cv = canvas; ctx = cv.getContext('2d');
    mmCv = minimap; mmCtx = mmCv.getContext('2d');
    RTS.scene3d.init(glCanvas);
  }

  function setMap(m, player) {
    map = m; myPlayer = player;
    particles = [];
    view.reset();
    fog = new Uint8Array(m.W * m.H);
    fogCv = document.createElement('canvas');
    fogCv.width = m.W; fogCv.height = m.H;
    fogCtx = fogCv.getContext('2d');
    buildTerrain();
    RTS.scene3d.setup(m, terrain, fogCv);
  }

  function buildTerrain() {
    terrain = document.createElement('canvas');
    terrain.width = map.W * T; terrain.height = map.H * T;
    const g = terrain.getContext('2d');
    const grad = g.createLinearGradient(0, 0, terrain.width, terrain.height);
    grad.addColorStop(0, '#0a0a20'); grad.addColorStop(1, '#0e0a28');
    g.fillStyle = grad;
    g.fillRect(0, 0, terrain.width, terrain.height);
    // grid
    g.strokeStyle = 'rgba(90,100,180,.14)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= map.W; x++) { g.moveTo(x * T + 0.5, 0); g.lineTo(x * T + 0.5, terrain.height); }
    for (let y = 0; y <= map.H; y++) { g.moveTo(0, y * T + 0.5); g.lineTo(terrain.width, y * T + 0.5); }
    g.stroke();
    // darker patches under rocks (3D boxes sit on top)
    for (let ty = 0; ty < map.H; ty++) for (let tx = 0; tx < map.W; tx++) {
      if (!map.rock[ty * map.W + tx]) continue;
      g.fillStyle = '#131327';
      g.fillRect(tx * T, ty * T, T, T);
    }
    // minimap ground
    mmTerrain = document.createElement('canvas');
    mmTerrain.width = map.W; mmTerrain.height = map.H;
    const mg = mmTerrain.getContext('2d');
    mg.fillStyle = '#0a0a20';
    mg.fillRect(0, 0, map.W, map.H);
    mg.fillStyle = '#2b2b52';
    for (let ty = 0; ty < map.H; ty++) for (let tx = 0; tx < map.W; tx++)
      if (map.rock[ty * map.W + tx]) mg.fillRect(tx, ty, 1, 1);
  }

  function updateFog(snap) {
    for (let i = 0; i < fog.length; i++) if (fog[i] === 2) fog[i] = 1;
    for (const e of snap.e) {
      if (e[2] !== myPlayer) continue;
      const k = K[KL[e[1]]];
      const sight = k.sight || 6;
      const cx = (e[3] / T) | 0, cy = (e[4] / T) | 0;
      for (let dy = -sight; dy <= sight; dy++) for (let dx = -sight; dx <= sight; dx++) {
        if (dx * dx + dy * dy > sight * sight) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= map.W || y >= map.H) continue;
        fog[y * map.W + x] = 2;
      }
    }
    // redraw fog canvas (1 px per tile; the 3D fog plane and minimap sample it)
    const img = fogCtx.createImageData(map.W, map.H);
    const d = img.data;
    for (let i = 0; i < fog.length; i++) {
      const a = fog[i] === 2 ? 0 : fog[i] === 1 ? 130 : 244;
      d[i * 4 + 0] = 4; d[i * 4 + 1] = 4; d[i * 4 + 2] = 14; d[i * 4 + 3] = a;
    }
    fogCtx.putImageData(img, 0, 0);
  }

  const visibleAt = (wx, wy) => {
    if (!fog) return true;
    const tx = (wx / T) | 0, ty = (wy / T) | 0;
    if (tx < 0 || ty < 0 || tx >= map.W || ty >= map.H) return false;
    return fog[ty * map.W + tx] === 2;
  };
  const exploredAt = (wx, wy) => {
    if (!fog) return true;
    const tx = (wx / T) | 0, ty = (wy / T) | 0;
    if (tx < 0 || ty < 0 || tx >= map.W || ty >= map.H) return false;
    return fog[ty * map.W + tx] >= 1;
  };

  // interpolated entity list for this frame
  function ents() {
    const next = view.next;
    if (!next) return [];
    const prevById = new Map();
    if (view.prev) for (const e of view.prev.e) prevById.set(e[0], e);
    const alpha = U.clamp((performance.now() - view.tNext) / view.dtSnap, 0, 1);
    const out = [];
    for (const e of next.e) {
      const p = prevById.get(e[0]);
      let x = e[3], y = e[4], face = e[6];
      if (p) {
        x = U.lerp(p[3], e[3], alpha);
        y = U.lerp(p[4], e[4], alpha);
        let df = ((e[6] - p[6] + 540) % 360) - 180;
        face = p[6] + df * alpha;
      }
      out.push({
        id: e[0], kind: KL[e[1]], owner: e[2], x, y, hp: e[5],
        face: face * Math.PI / 180, flags: e[7], qlen: e[8], prog: e[9], qkind: e[10],
      });
    }
    return out;
  }

  // an entity is drawable for me if fog allows it
  function drawable(e) {
    if (e.owner < 2 && e.owner !== myPlayer) {
      const vis = visibleAt(e.x, e.y);
      if (!vis && !K[e.kind].bld) return false;        // hidden enemy units
      if (!vis && !exploredAt(e.x, e.y)) return false; // unexplored enemy buildings
    }
    if (e.kind === 'crystal' && !exploredAt(e.x, e.y)) return false;
    return true;
  }

  function entAt(wx, wy) {
    let best = null, bd = 1e9;
    for (const e of ents()) {
      const k = K[e.kind];
      let hit = false;
      const d = U.dist2(wx, wy, e.x, e.y);
      if (k.bld) {
        hit = Math.abs(wx - e.x) < k.fw * T / 2 + 6 && Math.abs(wy - e.y) < k.fh * T / 2 + 6;
      } else {
        const r = (k.r || 10) + 8;
        hit = d < r * r;
      }
      if (hit && d < bd) {
        if (!drawable(e)) continue;
        bd = d; best = e;
      }
    }
    return best;
  }

  // ---- particles / events (drawn on the overlay at projected positions) ----
  function onEvent(ev) {
    const [kind, x, y] = ev;
    const S = U.sfx;
    switch (kind) {
      case EV.SHOT: S.shot(); break;
      case EV.HIT:
        spark(x, y, 4, '#ffd868'); S.hit(); break;
      case EV.BOOM:
        ring(x, y, 30, '#ff9628'); spark(x, y, 10, '#ff9628'); S.boom(); break;
      case EV.BIGBOOM:
        ring(x, y, 70, '#ff5050'); spark(x, y, 24, '#ff8850'); S.bigboom(); break;
      case EV.DEPOSIT:
        floatText(x, y, '+' + C.CARRY, '#50dc78'); S.deposit(); break;
      case EV.BUILT:
        ring(x, y, 44, '#00ffdc'); S.built(); break;
    }
  }
  const spark = (x, y, n, col) => {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 130;
      particles.push({ t: 'p', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5, max: 0.5, col });
    }
  };
  const ring = (x, y, r, col) => particles.push({ t: 'r', x, y, r, life: 0.5, max: 0.5, col });
  const floatText = (x, y, txt, col) => particles.push({ t: 't', x, y, txt, life: 1, max: 1, z: 30, col });

  function stepParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      if (p.t === 'p') { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; }
      if (p.t === 't') p.z += 30 * dt;
    }
  }

  // ---- main draw ----
  // st: { cam:{x,y,zoom}, sel:Set, placing:{kind,tx,ty,valid}|null, drag:{x0,y0,x1,y1}|null }
  function draw(st) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0.016);
    lastFrame = now;
    stepParticles(dt);

    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== (w * dpr | 0) || cv.height !== (h * dpr | 0)) {
      cv.width = w * dpr | 0; cv.height = h * dpr | 0;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h); // overlay is transparent; WebGL renders beneath
    if (!map || !view.next) return;

    const S3 = RTS.scene3d;
    S3.updateCamera(st.cam, w, h);

    const list = ents().filter(drawable);
    const projs = (view.next.p || []).filter((p) => exploredAt(p[0], p[1]));
    S3.render(list, projs, st.placing, st.sel);

    // ---- overlay: health bars ----
    for (const e of list) {
      const k = K[e.kind];
      const maxhp = e.kind === 'crystal' ? C.CRYSTAL_AMOUNT : k.hp;
      const frac = U.clamp(e.hp / maxhp, 0, 1);
      const selected = st.sel.has(e.id);
      const constructing = (e.flags & 2) !== 0;
      if (e.kind === 'crystal') continue;
      if (frac >= 1 && !selected && !constructing && !(k.bld && e.qlen > 0 && e.owner === myPlayer)) continue;
      const top = k.bld ? 52 : 26;
      const s = S3.worldToScreen(e.x, e.y, top);
      if (s.behind) continue;
      const wBar = k.bld ? 46 : 26;
      if (frac < 1 || selected) {
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.fillRect(s.x - wBar / 2, s.y, wBar, 4);
        ctx.fillStyle = frac > 0.5 ? '#50dc78' : frac > 0.25 ? '#ffd868' : '#ff5050';
        ctx.fillRect(s.x - wBar / 2, s.y, wBar * frac, 4);
      }
      if (constructing) {
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.fillRect(s.x - wBar / 2, s.y + 6, wBar, 4);
        ctx.fillStyle = '#00c8ff';
        ctx.fillRect(s.x - wBar / 2, s.y + 6, wBar * (e.prog / 100), 4);
      } else if (k.bld && e.qlen > 0 && e.owner === myPlayer) {
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.fillRect(s.x - wBar / 2, s.y + 6, wBar, 4);
        ctx.fillStyle = '#c88aff';
        ctx.fillRect(s.x - wBar / 2, s.y + 6, wBar * (e.prog / 100), 4);
      }
    }

    // ---- overlay: particles ----
    for (const p of particles) {
      const a = p.life / p.max;
      const s = S3.worldToScreen(p.x, p.y, p.z || 6);
      if (s.behind) continue;
      ctx.globalAlpha = a;
      if (p.t === 'p') {
        ctx.fillStyle = p.col;
        ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
      } else if (p.t === 'r') {
        ctx.strokeStyle = p.col;
        ctx.lineWidth = 3;
        const r = (p.r * (1 - a) + 6) / Math.max(0.4, RTS.scene3d.worldPerPixel());
        ctx.beginPath(); ctx.ellipse(s.x, s.y, r, r * 0.62, 0, 0, 7); ctx.stroke();
      } else if (p.t === 't') {
        ctx.fillStyle = p.col;
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(p.txt, s.x, s.y);
      }
      ctx.globalAlpha = 1;
    }

    // drag-select rectangle (screen space)
    if (st.drag) {
      ctx.strokeStyle = '#00ffdc';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        Math.min(st.drag.x0, st.drag.x1), Math.min(st.drag.y0, st.drag.y1),
        Math.abs(st.drag.x1 - st.drag.x0), Math.abs(st.drag.y1 - st.drag.y0));
      ctx.setLineDash([]);
    }

    drawMinimap(st, list, w, h);
  }

  function drawMinimap(st, list, w, h) {
    const S = mmCv.width;
    mmCtx.setTransform(1, 0, 0, 1, 0, 0);
    mmCtx.imageSmoothingEnabled = false;
    mmCtx.clearRect(0, 0, S, S);
    mmCtx.drawImage(mmTerrain, 0, 0, S, S);
    const sc = S / (map.W * T);
    for (const e of list) {
      mmCtx.fillStyle = e.owner === 2 ? RTS.NCOL.main : RTS.PCOL[e.owner].main;
      const sz = K[e.kind].bld ? 4 : 2;
      mmCtx.fillRect(e.x * sc - sz / 2, e.y * sc - sz / 2, sz, sz);
    }
    // fog overlay
    mmCtx.globalAlpha = 0.85;
    mmCtx.drawImage(fogCv, 0, 0, map.W, map.H, 0, 0, S, S);
    mmCtx.globalAlpha = 1;
    // viewport trapezoid (project the 4 screen corners onto the ground)
    const cs = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => RTS.scene3d.screenToWorld(x, y));
    mmCtx.strokeStyle = '#ffffff';
    mmCtx.lineWidth = 1;
    mmCtx.beginPath();
    cs.forEach((c, i) => {
      const px = U.clamp(c.x * sc, 0, S), py = U.clamp(c.y * sc, 0, S);
      if (i === 0) mmCtx.moveTo(px, py); else mmCtx.lineTo(px, py);
    });
    mmCtx.closePath();
    mmCtx.stroke();
  }

  return { initCanvas, setMap, view, draw, ents, entAt, visibleAt, exploredAt, drawable };
})();
