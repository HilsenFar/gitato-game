// GITATO COMMAND — input: selection, orders, camera, placement, touch
'use strict';

RTS.input = (() => {
  const C = RTS.C, K = RTS.KINDS, U = RTS.util;
  const T = C.TILE;

  let game = null, cv = null, mmCv = null;
  let mouse = { x: 0, y: 0, inside: false };
  let drag = null;            // {x0,y0,x1,y1} screen space
  let panDrag = null;         // {sx,sy,camX,camY}
  const keys = new Set();
  let attackMod = false;
  let touchState = null;

  function init(g, canvas, minimap) {
    game = g; cv = canvas; mmCv = minimap;

    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    cv.addEventListener('mouseenter', () => { mouse.inside = true; });
    cv.addEventListener('mouseleave', () => { mouse.inside = false; });
    cv.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', (e) => keys.delete(e.code));
    window.addEventListener('blur', () => keys.clear());

    cv.addEventListener('touchstart', onTouchStart, { passive: false });
    cv.addEventListener('touchmove', onTouchMove, { passive: false });
    cv.addEventListener('touchend', onTouchEnd, { passive: false });

    mmCv.addEventListener('mousedown', (e) => { minimapJump(e); mmCv.dragging = true; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (mmCv.dragging) minimapJump(e); });
    window.addEventListener('mouseup', () => { mmCv.dragging = false; });
    mmCv.addEventListener('touchstart', (e) => { minimapJump(e.touches[0]); e.preventDefault(); }, { passive: false });
    mmCv.addEventListener('touchmove', (e) => { minimapJump(e.touches[0]); e.preventDefault(); }, { passive: false });
  }

  // screen → ground-plane world point (perspective raycast)
  const s2w = (sx, sy) => RTS.scene3d.screenToWorld(sx, sy);

  function clampCam() {
    // cam.x / cam.y is the ground point at the center of the screen
    const cam = game.cam;
    const W = C.MAP_W * T, H = C.MAP_H * T;
    cam.x = U.clamp(cam.x, 0, W);
    cam.y = U.clamp(cam.y, 0, H);
  }

  function minimapJump(e) {
    const r = mmCv.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    game.cam.x = fx * C.MAP_W * T;
    game.cam.y = fy * C.MAP_H * T;
    clampCam();
  }

  // ---- mouse ----
  function onMouseDown(e) {
    if (game.mode === 'menu') return;
    U.audio();
    const rect = cv.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (e.button === 1) { panDrag = { sx: e.clientX, sy: e.clientY, camX: game.cam.x, camY: game.cam.y }; e.preventDefault(); return; }
    if (e.button === 0) {
      if (game.placing) { tryPlace(sx, sy); return; }
      if (attackMod) { issueAttackMove(sx, sy); setAttackMod(false); return; }
      drag = { x0: sx, y0: sy, x1: sx, y1: sy };
      return;
    }
    if (e.button === 2) {
      if (game.placing) { game.placing = null; return; }
      if (attackMod) { setAttackMod(false); return; }
      rightCommand(sx, sy);
    }
  }

  function onMouseMove(e) {
    const rect = cv.getBoundingClientRect();
    mouse.x = e.clientX - rect.left; mouse.y = e.clientY - rect.top;
    if (drag) { drag.x1 = mouse.x; drag.y1 = mouse.y; }
    if (panDrag) {
      const wpp = RTS.scene3d.worldPerPixel();
      game.cam.x = panDrag.camX - (e.clientX - panDrag.sx) * wpp;
      game.cam.y = panDrag.camY - (e.clientY - panDrag.sy) * wpp;
      clampCam();
    }
  }

  function onMouseUp(e) {
    if (e.button === 1) { panDrag = null; return; }
    if (e.button !== 0 || !drag) return;
    const d = drag; drag = null;
    if (Math.abs(d.x1 - d.x0) < 6 && Math.abs(d.y1 - d.y0) < 6) clickSelect(d.x0, d.y0, e.shiftKey);
    else boxSelect(d, e.shiftKey);
  }

  function onWheel(e) {
    e.preventDefault();
    if (game.mode === 'menu') return;
    const cam = game.cam;
    const rect = cv.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = s2w(sx, sy);
    cam.zoom = U.clamp(cam.zoom * (e.deltaY > 0 ? 0.88 : 1.14), 0.45, 2.2);
    RTS.scene3d.updateCamera(cam, cv.clientWidth, cv.clientHeight);
    const after = s2w(sx, sy);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
    clampCam();
  }

  // ---- keyboard ----
  function onKeyDown(e) {
    if (game.mode === 'menu') return;
    keys.add(e.code);
    // while paused only Escape may act (unpause); modifier combos (Ctrl+F etc.)
    // belong to the browser, not the game
    if ((game.paused && e.code !== 'Escape') || e.ctrlKey || e.metaKey || e.altKey) return;
    // command-card hotkeys (train buttons etc., physical codes like KeyQ)
    if (game.cardHotkeys && game.cardHotkeys[e.code]) {
      U.sfx.click();
      game.cardHotkeys[e.code]();
      return;
    }
    switch (e.code) {
      case 'KeyA': if (game.sel.size && !game.placing) setAttackMod(true); break;
      case 'KeyS': sendToSel('stop'); break;
      case 'KeyG': gatherIdle(); break;
      case 'KeyM': {
        const m = U.toggleMute();
        const btn = document.getElementById('btn-mute');
        if (btn) btn.textContent = m ? '🔇' : '🔊';
        break;
      }
      case 'Escape':
        if (game.paused) { if (game.togglePause) game.togglePause(); }
        else if (game.placing) game.placing = null;
        else if (attackMod) setAttackMod(false);
        else if (game.sel.size) { game.sel.clear(); game.onSelChange(); }
        else if (game.togglePause) game.togglePause();
        break;
    }
  }

  function setAttackMod(v) {
    attackMod = v;
    cv.classList.toggle('attack-cursor', v);
    const b = document.getElementById('btn-amove');
    if (b) b.classList.toggle('active', v);
  }

  // ---- selection ----
  function myEnts() { return RTS.render.ents().filter((e) => e.owner === game.myPlayer); }

  function clickSelect(sx, sy, add) {
    const w = s2w(sx, sy);
    const e = RTS.render.entAt(w.x, w.y);
    if (!add) game.sel.clear();
    if (e && e.owner === game.myPlayer) {
      if (game.sel.has(e.id) && add) game.sel.delete(e.id);
      else { game.sel.add(e.id); U.sfx.select(); }
    }
    game.onSelChange();
  }

  function boxSelect(d, add) {
    // perspective camera → compare in screen space, not world space
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
    const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
    const inRect = (e) => {
      const s = RTS.scene3d.worldToScreen(e.x, e.y, 0);
      return !s.behind && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
    };
    if (!add) game.sel.clear();
    const units = myEnts().filter((e) => K[e.kind].unit && inRect(e));
    if (units.length) {
      units.forEach((e) => game.sel.add(e.id));
      U.sfx.select();
    } else {
      const bld = myEnts().find((e) => K[e.kind].bld && inRect(e));
      if (bld) { game.sel.add(bld.id); U.sfx.select(); }
    }
    game.onSelChange();
  }

  function selEnts() {
    return RTS.render.ents().filter((e) => game.sel.has(e.id) && e.owner === game.myPlayer);
  }

  // ---- orders ----
  function sendToSel(c, extra) {
    const ids = selEnts().filter((e) => K[e.kind].unit).map((e) => e.id);
    if (!ids.length) return;
    game.sendCmd(Object.assign({ c, ids }, extra || {}));
    U.sfx.order();
  }

  function rightCommand(sx, sy) {
    const w = s2w(sx, sy);
    const sel = selEnts();
    if (!sel.length) return;
    const units = sel.filter((e) => K[e.kind].unit);
    const blds = sel.filter((e) => K[e.kind].bld);
    const target = RTS.render.entAt(w.x, w.y);

    if (blds.length && !units.length) { // set rally
      game.sendCmd({ c: 'rally', ids: blds.map((e) => e.id), x: w.x, y: w.y, tid: target && target.kind === 'crystal' ? target.id : 0 });
      game.toast(RTS.STR.rallySet);
      U.sfx.order();
      return;
    }
    if (!units.length) return;

    if (target && target.owner !== game.myPlayer && target.owner < 2) {
      game.sendCmd({ c: 'attack', ids: units.map((e) => e.id), tid: target.id });
    } else if (target && target.kind === 'crystal') {
      const workers = units.filter((e) => e.kind === 'worker');
      const rest = units.filter((e) => e.kind !== 'worker');
      if (workers.length) game.sendCmd({ c: 'harvest', ids: workers.map((e) => e.id), tid: target.id });
      if (rest.length) game.sendCmd({ c: 'move', ids: rest.map((e) => e.id), x: w.x, y: w.y });
    } else if (target && target.owner === game.myPlayer && K[target.kind].bld && (target.flags & 2)) {
      const workers = units.filter((e) => e.kind === 'worker');
      if (workers.length) game.sendCmd({ c: 'repair', ids: workers.map((e) => e.id), tid: target.id });
    } else {
      game.sendCmd({ c: 'move', ids: units.map((e) => e.id), x: w.x, y: w.y });
    }
    U.sfx.order();
  }

  function issueAttackMove(sx, sy) {
    const w = s2w(sx, sy);
    sendToSel('amove', { x: w.x, y: w.y });
  }

  // send every idle worker back to the nearest crystal (host resolves who is idle)
  function gatherIdle() {
    game.sendCmd({ c: 'gather' });
    U.sfx.order();
  }

  // ---- placement ----
  function placingValid(kind, tx, ty) {
    const k = K[kind], map = game.map;
    if (tx < 0 || ty < 0 || tx + k.fw > map.W || ty + k.fh > map.H) return false;
    // rock check
    for (let y = ty; y < ty + k.fh; y++)
      for (let x = tx; x < tx + k.fw; x++)
        if (map.rock[y * map.W + x]) return false;
    // entity footprint / crystal check from the live view
    const x0 = tx * T, y0 = ty * T, x1 = (tx + k.fw) * T, y1 = (ty + k.fh) * T;
    for (const e of RTS.render.ents()) {
      if (e.kind === 'crystal') {
        if (e.x > x0 - T / 2 && e.x < x1 + T / 2 && e.y > y0 - T / 2 && e.y < y1 + T / 2) return false;
      } else if (K[e.kind].bld) {
        const bk = K[e.kind];
        const bx0 = e.x - bk.fw * T / 2, by0 = e.y - bk.fh * T / 2;
        if (bx0 < x1 && bx0 + bk.fw * T > x0 && by0 < y1 && by0 + bk.fh * T > y0) return false;
      }
    }
    // must be explored
    return RTS.render.exploredAt((x0 + x1) / 2, (y0 + y1) / 2);
  }

  function tryPlace(sx, sy) {
    const p = game.placing;
    if (!p) return;
    // every selected worker helps build → the more you bring, the faster it goes.
    // placer first so it's the one that survives the footprint deduction.
    const workers = selEnts().filter((e) => e.kind === 'worker');
    if (!workers.length) { game.placing = null; return; }
    if (!p.valid) { U.sfx.error(); game.toast(RTS.STR.invalidSpot); return; }
    const snap = RTS.render.view.next;
    if (snap && snap.res[game.myPlayer] < K[p.kind].cost) {
      U.sfx.error(); game.toast(RTS.STR.needCrystals); game.placing = null; return;
    }
    game.sendCmd({ c: 'build', ids: workers.map((e) => e.id), kind: p.kind, x: p.tx, y: p.ty });
    U.sfx.order();
    game.placing = null;
  }

  // ---- touch ----
  function onTouchStart(e) {
    if (game.mode === 'menu') return;
    e.preventDefault();
    U.audio();
    const rect = cv.getBoundingClientRect();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchState = {
        mode: 'tap', x0: t.clientX - rect.left, y0: t.clientY - rect.top,
        x1: t.clientX - rect.left, y1: t.clientY - rect.top, t0: performance.now(),
      };
      if (game.placing) {
        touchState.mode = 'place';
        updatePlacingAt(touchState.x0, touchState.y0);
      }
    } else if (e.touches.length === 2 && touchState) {
      touchState = {
        mode: 'pan',
        d0: touchDist(e), cx: game.cam.x, cy: game.cam.y, z0: game.cam.zoom,
        mx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        my: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
      drag = null;
    }
  }

  const touchDist = (e) => U.dist(e.touches[0].clientX, e.touches[0].clientY, e.touches[1].clientX, e.touches[1].clientY);

  function onTouchMove(e) {
    if (!touchState) return;
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    if (touchState.mode === 'pan' && e.touches.length === 2) {
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      game.cam.zoom = U.clamp(touchState.z0 * (touchDist(e) / touchState.d0), 0.45, 2.2);
      const wpp = RTS.scene3d.worldPerPixel();
      game.cam.x = touchState.cx - (mx - touchState.mx) * wpp;
      game.cam.y = touchState.cy - (my - touchState.my) * wpp;
      clampCam();
      return;
    }
    const t = e.touches[0];
    touchState.x1 = t.clientX - rect.left; touchState.y1 = t.clientY - rect.top;
    if (touchState.mode === 'place') { updatePlacingAt(touchState.x1, touchState.y1); return; }
    if (Math.abs(touchState.x1 - touchState.x0) > 14 || Math.abs(touchState.y1 - touchState.y0) > 14) {
      touchState.mode = 'box';
      drag = { x0: touchState.x0, y0: touchState.y0, x1: touchState.x1, y1: touchState.y1 };
    }
  }

  function onTouchEnd(e) {
    if (!touchState) return;
    e.preventDefault();
    const ts = touchState;
    if (e.touches.length > 0) return; // wait for all fingers up
    touchState = null;
    if (ts.mode === 'pan') return;
    if (ts.mode === 'place') { tryPlace(ts.x1, ts.y1); return; }
    if (ts.mode === 'box') { const d = drag; drag = null; if (d) boxSelect(d, false); return; }
    // tap: select own, else contextual command
    const w = s2w(ts.x0, ts.y0);
    const target = RTS.render.entAt(w.x, w.y);
    const held = performance.now() - ts.t0;
    if (target && target.owner === game.myPlayer) { clickSelect(ts.x0, ts.y0, false); return; }
    if (game.sel.size) {
      if (held > 450) issueAttackMove(ts.x0, ts.y0);
      else rightCommand(ts.x0, ts.y0);
    }
  }

  function updatePlacingAt(sx, sy) {
    const p = game.placing;
    if (!p) return;
    const w = s2w(sx, sy);
    const k = K[p.kind];
    p.tx = Math.round(w.x / T - k.fw / 2);
    p.ty = Math.round(w.y / T - k.fh / 2);
    p.valid = placingValid(p.kind, p.tx, p.ty);
  }

  // ---- per-frame ----
  function update(dt) {
    if (game.mode === 'menu') return;
    const cam = game.cam;
    const sp = 620 * dt / cam.zoom;
    if (keys.has('ArrowLeft')) cam.x -= sp;
    if (keys.has('ArrowRight')) cam.x += sp;
    if (keys.has('ArrowUp')) cam.y -= sp;
    if (keys.has('ArrowDown')) cam.y += sp;
    // edge pan (mouse only)
    if (mouse.inside && !panDrag && !drag) {
      const M = 22;
      if (mouse.x < M) cam.x -= sp;
      if (mouse.x > cv.clientWidth - M) cam.x += sp;
      if (mouse.y < M) cam.y -= sp;
      if (mouse.y > cv.clientHeight - M) cam.y += sp;
    }
    clampCam();
    if (game.placing && mouse.inside) updatePlacingAt(mouse.x, mouse.y);
  }

  const getDrag = () => drag;
  return { init, update, getDrag, selEnts, setAttackMod, issueAttackMove, sendToSel, gatherIdle };
})();
