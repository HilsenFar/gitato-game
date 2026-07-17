// GITATO COMMAND — canvas renderer: interpolated view, fog of war, minimap, particles
'use strict';

RTS.render = (() => {
  const C = RTS.C, K = RTS.KINDS, KL = RTS.KIND_LIST, U = RTS.util;
  const T = C.TILE, EV = RTS.EV;

  let cv, ctx, mmCv, mmCtx;
  let map = null;
  let terrain = null;        // cached ground canvas
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

  function initCanvas(canvas, minimap) {
    cv = canvas; ctx = cv.getContext('2d');
    mmCv = minimap; mmCtx = mmCv.getContext('2d');
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
  }

  function buildTerrain() {
    terrain = document.createElement('canvas');
    terrain.width = map.W * T; terrain.height = map.H * T;
    const g = terrain.getContext('2d');
    const grad = g.createLinearGradient(0, 0, terrain.width, terrain.height);
    grad.addColorStop(0, '#07071a'); grad.addColorStop(1, '#0b0722');
    g.fillStyle = grad;
    g.fillRect(0, 0, terrain.width, terrain.height);
    // grid
    g.strokeStyle = 'rgba(80,90,160,.10)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= map.W; x++) { g.moveTo(x * T + 0.5, 0); g.lineTo(x * T + 0.5, terrain.height); }
    for (let y = 0; y <= map.H; y++) { g.moveTo(0, y * T + 0.5); g.lineTo(terrain.width, y * T + 0.5); }
    g.stroke();
    // rocks
    const rnd = U.rng(7);
    for (let ty = 0; ty < map.H; ty++) for (let tx = 0; tx < map.W; tx++) {
      if (!map.rock[ty * map.W + tx]) continue;
      const x = tx * T, y = ty * T;
      g.fillStyle = '#1a1a34';
      g.fillRect(x, y, T, T);
      g.fillStyle = '#242348';
      const n = 2 + (rnd() * 3 | 0);
      for (let i = 0; i < n; i++) {
        const px = x + rnd() * (T - 10), py = y + rnd() * (T - 10);
        g.beginPath();
        g.moveTo(px, py + 8); g.lineTo(px + 5, py); g.lineTo(px + 12, py + 3); g.lineTo(px + 10, py + 10);
        g.closePath(); g.fill();
      }
      g.strokeStyle = 'rgba(120,120,220,.16)';
      g.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1);
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
        if (x < 0 || y < 0 || x >= map.W || y >= map.W) continue;
        fog[y * map.W + x] = 2;
      }
    }
    // redraw fog canvas (1 px per tile, scaled smooth on blit)
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

  function entAt(wx, wy) {
    let best = null, bd = 1e9;
    for (const e of ents()) {
      const k = K[e.kind];
      let hit = false, d = U.dist2(wx, wy, e.x, e.y);
      if (k.bld) {
        hit = Math.abs(wx - e.x) < k.fw * T / 2 + 4 && Math.abs(wy - e.y) < k.fh * T / 2 + 4;
      } else {
        const r = (k.r || 10) + 6;
        hit = d < r * r;
      }
      if (hit && d < bd) {
        if (e.owner !== myPlayer && e.owner < 2 && !visibleAt(e.x, e.y)) continue;
        bd = d; best = e;
      }
    }
    return best;
  }

  // ---- particles / events ----
  function onEvent(ev) {
    const [kind, x, y] = ev;
    const S = U.sfx;
    const onScreen = true; // events are rare enough to always play
    switch (kind) {
      case EV.SHOT: if (onScreen) S.shot(); break;
      case EV.HIT:
        spark(x, y, 4, '#ffd868'); if (onScreen) S.hit(); break;
      case EV.BOOM:
        ring(x, y, 30, '#ff9628'); spark(x, y, 10, '#ff9628'); S.boom(); break;
      case EV.BIGBOOM:
        ring(x, y, 70, '#ff5050'); spark(x, y, 24, '#ff8850'); S.bigboom(); break;
      case EV.DEPOSIT:
        floatText(x, y - 20, '+' + C.CARRY, '#50dc78'); S.deposit(); break;
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
  const floatText = (x, y, txt, col) => particles.push({ t: 't', x, y, txt, life: 1, max: 1, col });

  function stepParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      if (p.t === 'p') { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; }
      if (p.t === 't') p.y -= 24 * dt;
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
    ctx.fillStyle = '#04040c';
    ctx.fillRect(0, 0, w, h);
    if (!map || !view.next) return;

    const cam = st.cam;
    ctx.save();
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    // ground
    ctx.drawImage(terrain, 0, 0);

    const list = ents();
    const selSet = st.sel;

    // buildings first, then crystals, then units
    const drawOrder = list.slice().sort((a, b) => (K[a.kind].bld ? 0 : a.kind === 'crystal' ? 1 : 2) - (K[b.kind].bld ? 0 : b.kind === 'crystal' ? 1 : 2));
    for (const e of drawOrder) {
      if (e.owner < 2 && e.owner !== myPlayer) {
        const vis = visibleAt(e.x, e.y);
        if (!vis && !K[e.kind].bld) continue;        // hidden enemy units
        if (!vis && !exploredAt(e.x, e.y)) continue; // unexplored enemy buildings
      }
      if (e.kind === 'crystal' && !exploredAt(e.x, e.y)) continue;
      drawEnt(e, selSet.has(e.id));
    }

    // projectiles
    for (const p of view.next.p || []) {
      if (!visibleAt(p[0], p[1]) && !exploredAt(p[0], p[1])) continue;
      if (p[2] === 1) { // shell
        ctx.fillStyle = '#ffb050';
        glow('#ffb050', 8);
        ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, 7); ctx.fill();
      } else {
        ctx.strokeStyle = '#eaffff';
        glow('#00ffdc', 6);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p[0] - 4, p[1]); ctx.lineTo(p[0] + 4, p[1]); ctx.stroke();
      }
      noGlow();
    }

    // particles
    for (const p of particles) {
      const a = p.life / p.max;
      if (p.t === 'p') {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.col;
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      } else if (p.t === 'r') {
        ctx.globalAlpha = a;
        ctx.strokeStyle = p.col;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 - a) + 6, 0, 7); ctx.stroke();
      } else if (p.t === 't') {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.col;
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(p.txt, p.x, p.y);
      }
      ctx.globalAlpha = 1;
    }

    // placement ghost
    if (st.placing) {
      const k = K[st.placing.kind];
      const x = st.placing.tx * T, y = st.placing.ty * T;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = st.placing.valid ? '#00ffdc' : '#ff4060';
      ctx.fillRect(x, y, k.fw * T, k.fh * T);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = st.placing.valid ? '#00ffdc' : '#ff4060';
      ctx.strokeRect(x + 1, y + 1, k.fw * T - 2, k.fh * T - 2);
    }

    // fog (scaled up, smoothed)
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fogCv, 0, 0, map.W, map.H, 0, 0, map.W * T, map.H * T);

    ctx.restore();

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

    drawMinimap(st, list);
  }

  const glow = (col, blur) => { ctx.shadowColor = col; ctx.shadowBlur = blur; };
  const noGlow = () => { ctx.shadowBlur = 0; };

  function pcol(owner) { return owner === 2 ? RTS.NCOL : RTS.PCOL[owner]; }

  function drawEnt(e, selected) {
    const k = K[e.kind], col = pcol(e.owner);
    ctx.save();
    ctx.translate(e.x, e.y);

    if (selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      const sr = k.bld ? Math.max(k.fw, k.fh) * T * 0.62 : (k.r || 10) + 5;
      ctx.beginPath(); ctx.arc(0, 0, sr, 0, 7); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const constructing = (e.flags & 2) !== 0;
    if (constructing) ctx.globalAlpha = 0.45 + 0.4 * (e.prog / 100);

    glow(col.main, 10);
    ctx.strokeStyle = col.main;
    ctx.fillStyle = col.dim;
    ctx.lineWidth = 2;

    switch (e.kind) {
      case 'crystal': {
        const sc = 0.5 + 0.5 * (e.hp / C.CRYSTAL_AMOUNT);
        glow(RTS.NCOL.main, 12);
        ctx.strokeStyle = RTS.NCOL.main;
        ctx.fillStyle = 'rgba(80,220,120,.25)';
        ctx.beginPath();
        ctx.moveTo(0, -12 * sc); ctx.lineTo(9 * sc, 0); ctx.lineTo(0, 12 * sc); ctx.lineTo(-9 * sc, 0);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        break;
      }
      case 'worker': {
        ctx.beginPath(); ctx.arc(0, 0, 7, 0, 7); ctx.fill(); ctx.stroke();
        ctx.rotate(e.face);
        ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(12, 0); ctx.stroke();
        if (e.flags & 1) { ctx.fillStyle = RTS.NCOL.main; ctx.fillRect(3, -3, 5, 5); }
        break;
      }
      case 'marine': {
        ctx.rotate(e.face);
        ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, -7); ctx.lineTo(-4, 0); ctx.lineTo(-7, 7);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        if (e.flags & 4) { ctx.fillStyle = '#fff'; ctx.fillRect(11, -1.5, 5, 3); }
        break;
      }
      case 'brute': {
        ctx.rotate(e.face);
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const a = i * Math.PI * 2 / 5;
          ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * 12, Math.sin(a) * 12);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(14, 0); ctx.stroke();
        break;
      }
      case 'mortar': {
        ctx.rotate(e.face);
        ctx.fillRect(-9, -8, 18, 16); ctx.strokeRect(-9, -8, 18, 16);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(16, 0); ctx.lineWidth = 4; ctx.stroke();
        break;
      }
      case 'hq': {
        const R = T * 1.35;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = i * Math.PI / 3 - Math.PI / 6;
          ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * R, Math.sin(a) * R);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, R * 0.45, 0, 7); ctx.stroke();
        break;
      }
      case 'rax': {
        ctx.fillRect(-T, -T * 0.8, T * 2, T * 1.6); ctx.strokeRect(-T, -T * 0.8, T * 2, T * 1.6);
        ctx.beginPath(); ctx.moveTo(-10, 8); ctx.lineTo(0, -8); ctx.lineTo(10, 8); ctx.stroke();
        break;
      }
      case 'fact': {
        ctx.fillRect(-T, -T * 0.8, T * 2, T * 1.6); ctx.strokeRect(-T, -T * 0.8, T * 2, T * 1.6);
        ctx.beginPath(); ctx.arc(-8, 0, 7, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.arc(9, 0, 7, 0, 7); ctx.stroke();
        break;
      }
      case 'turret': {
        ctx.beginPath(); ctx.arc(0, 0, 11, 0, 7); ctx.fill(); ctx.stroke();
        ctx.rotate(e.face);
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(17, 0); ctx.stroke();
        if (e.flags & 4) { ctx.fillStyle = '#fff'; ctx.fillRect(16, -2, 5, 4); }
        break;
      }
    }
    noGlow();
    ctx.globalAlpha = 1;
    ctx.restore();

    // bars (world space, after restore)
    const maxhp = e.kind === 'crystal' ? C.CRYSTAL_AMOUNT : K[e.kind].hp;
    const frac = U.clamp(e.hp / maxhp, 0, 1);
    const wBar = k.bld ? k.fw * T * 0.9 : 22;
    const yBar = e.y - (k.bld ? k.fh * T * 0.62 : (k.r || 10) + 9);
    if (e.kind !== 'crystal' && (frac < 1 || selected)) {
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(e.x - wBar / 2, yBar, wBar, 4);
      ctx.fillStyle = frac > 0.5 ? '#50dc78' : frac > 0.25 ? '#ffd868' : '#ff5050';
      ctx.fillRect(e.x - wBar / 2, yBar, wBar * frac, 4);
    }
    if (constructing) {
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(e.x - wBar / 2, yBar + 6, wBar, 4);
      ctx.fillStyle = '#00c8ff';
      ctx.fillRect(e.x - wBar / 2, yBar + 6, wBar * (e.prog / 100), 4);
    } else if (k.bld && e.qlen > 0 && e.owner === myPlayer) {
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(e.x - wBar / 2, yBar + 6, wBar, 4);
      ctx.fillStyle = '#c88aff';
      ctx.fillRect(e.x - wBar / 2, yBar + 6, wBar * (e.prog / 100), 4);
    }
  }

  function drawMinimap(st, list) {
    const S = mmCv.width; // square, e.g. 160
    mmCtx.setTransform(1, 0, 0, 1, 0, 0);
    mmCtx.imageSmoothingEnabled = false;
    mmCtx.clearRect(0, 0, S, S);
    mmCtx.drawImage(mmTerrain, 0, 0, S, S);
    const sc = S / (map.W * T);
    for (const e of list) {
      if (e.owner < 2 && e.owner !== myPlayer && !visibleAt(e.x, e.y)) {
        if (!K[e.kind].bld || !exploredAt(e.x, e.y)) continue;
      }
      if (e.kind === 'crystal' && !exploredAt(e.x, e.y)) continue;
      mmCtx.fillStyle = e.owner === 2 ? RTS.NCOL.main : RTS.PCOL[e.owner].main;
      const sz = K[e.kind].bld ? 4 : 2;
      mmCtx.fillRect(e.x * sc - sz / 2, e.y * sc - sz / 2, sz, sz);
    }
    // fog overlay
    mmCtx.globalAlpha = 0.85;
    mmCtx.drawImage(fogCv, 0, 0, map.W, map.H, 0, 0, S, S);
    mmCtx.globalAlpha = 1;
    // viewport rect
    const vw = cv.clientWidth / st.cam.zoom, vh = cv.clientHeight / st.cam.zoom;
    mmCtx.strokeStyle = '#ffffff';
    mmCtx.lineWidth = 1;
    mmCtx.strokeRect(st.cam.x * sc, st.cam.y * sc, vw * sc, vh * sc);
  }

  return { initCanvas, setMap, view, draw, ents, entAt, visibleAt, exploredAt };
})();
