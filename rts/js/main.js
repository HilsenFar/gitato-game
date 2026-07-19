// GITATO COMMAND — app bootstrap: menus, HUD, game loop, host/client glue
'use strict';

(() => {
  const C = RTS.C, K = RTS.KINDS, KL = RTS.KIND_LIST, U = RTS.util, STR = RTS.STR;
  const $ = (id) => document.getElementById(id);

  const game = {
    mode: 'menu',        // menu | skirmish | host | client
    myPlayer: 0,
    map: null,
    sim: null,
    ai: null,
    cam: { x: 0, y: 0, zoom: 1 },
    sel: new Set(),
    placing: null,
    pending: [],         // local commands waiting for the next tick
    remote: [],          // commands received from the connected client
    overShown: false,
    roomCode: '',
    cardHotkeys: {},     // physical key code -> command-card action

    sendCmd(cmd) {
      cmd.p = game.myPlayer;
      if (game.mode === 'client') RTS.net.send({ c: 'cmds', list: [cmd] });
      else game.pending.push(cmd);
    },
    onSelChange() { buildCommandCard(); },
    toast(msg) {
      const el = $('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove('show'), 1800);
    },
  };

  let simTimer = null;
  let pingTimer = null;
  let lastPeerMsg = 0; // heartbeat: WebRTC close events are unreliable across browsers

  // ---------- menus ----------
  function show(id) {
    for (const p of document.querySelectorAll('.panel')) p.classList.remove('show');
    if (id) $(id).classList.add('show');
  }

  function toMenu() {
    stopGame();
    paused = false; game.paused = false;
    game.mode = 'menu';
    $('hud').classList.remove('show');
    $('menu-msg').textContent = '';
    show('menu');
  }

  function stopGame() {
    paused = false; game.paused = false; // every teardown path must resync both pause flags
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    RTS.net.destroy();
    game.sim = null; game.ai = null;
    game.sel.clear(); game.placing = null;
    game.pending = []; game.remote = [];
    game.overShown = false;
    RTS.render.view.reset();
  }

  function startLocal(vsAi) {
    stopGame();
    const seed = (Math.random() * 0xffffffff) >>> 0;
    beginMatch(vsAi ? 'skirmish' : 'host', 0, seed);
    if (vsAi) game.ai = RTS.ai.create(1, game.diff); // difficulty from the menu row
  }

  // authoritative loop (setInterval so the sim survives a hidden tab)
  function startSimLoop() {
    if (simTimer) return;
    simTimer = setInterval(() => {
      const cmds = game.pending.concat(game.remote);
      game.pending = []; game.remote = [];
      if (game.ai) cmds.push(...RTS.ai.think(game.ai, game.sim));
      RTS.sim.step(game.sim, cmds);
      if (game.sim.tick % C.SNAP_EVERY === 0) {
        const snap = RTS.sim.snapshot(game.sim);
        RTS.render.view.push(snap);
        if (game.mode === 'host') RTS.net.send({ c: 'snap', s: snap });
        checkOver(snap);
      }
    }, C.TICK_MS);
  }

  // ---- pause (ESC / ☰) — only skirmish can freeze the sim; online keeps running ----
  let paused = false;
  function setPaused(on) {
    if (game.mode === 'menu') return;
    if (game.overShown) return; // ESC/burger must not replace the results panel after game over
    if (paused === on) return;
    paused = on;
    game.paused = on;
    if (on) {
      $('btn-pause-restart').style.display = game.mode === 'skirmish' ? '' : 'none';
      $('pause-note').textContent = game.mode === 'skirmish' ? '' : STR.pauseMpNote;
      show('pause');
      if (game.mode === 'skirmish' && simTimer) { clearInterval(simTimer); simTimer = null; }
    } else {
      show(null);
      if (game.mode === 'skirmish') startSimLoop();
    }
  }

  function beginMatch(mode, myPlayer, seed) {
    game.mode = mode;
    game.myPlayer = myPlayer;
    game.seed = seed;
    game.map = RTS.map.generate(seed);
    RTS.render.setMap(game.map, myPlayer);
    if (mode !== 'client') game.sim = RTS.sim.init(seed);

    // camera centered on own base (cam.x/y = ground point at screen center)
    const st = game.map.starts[myPlayer];
    game.cam.zoom = 1;
    game.cam.x = st.tx * C.TILE;
    game.cam.y = st.ty * C.TILE;

    show(null);
    $('hud').classList.add('show');
    $('hud-color').textContent = STR.youAre.replace('{color}', myPlayer === 0 ? STR.cyan : STR.magenta);
    $('hud-color').style.color = RTS.PCOL[myPlayer].main;
    $('hud-room').textContent = game.roomCode && mode !== 'skirmish' ? STR.room.replace('{code}', game.roomCode) : '';
    buildCommandCard();

    if (mode !== 'client') {
      if (mode === 'host') {
        lastPeerMsg = performance.now();
        pingTimer = setInterval(() => {
          if (performance.now() - lastPeerMsg > 10000) onPeerGone();
        }, 2000);
      }
      startSimLoop();
    } else {
      lastPeerMsg = performance.now();
      pingTimer = setInterval(() => {
        RTS.net.send({ c: 'ping' });
        if (performance.now() - lastPeerMsg > 10000) onPeerGone();
      }, 2000);
    }
  }

  // ---------- online ----------
  function hostOnline() {
    stopGame();
    const code = U.roomCode(4);
    game.roomCode = code;
    $('menu-msg').textContent = STR.connecting;
    RTS.net.host(code, {
      onOpen: () => { $('menu-msg').textContent = STR.waiting.replace('{code}', code); },
      onPeer: () => {
        const seed = (Math.random() * 0xffffffff) >>> 0;
        RTS.net.send({ c: 'init', seed });
        beginMatch('host', 0, seed);
      },
      onMsg: (m) => {
        lastPeerMsg = performance.now();
        if (m && m.c === 'cmds') {
          for (const cmd of m.list || []) {
            cmd.p = 1; // never trust the sender's player id
            game.remote.push(cmd);
          }
        }
      },
      onClose: () => onPeerGone(),
      onError: (kind) => {
        if (game.mode === 'menu') $('menu-msg').textContent = kind === 'taken' ? STR.connecting : STR.netFail;
        if (kind === 'taken') hostOnline(); // rare code collision: pick a new code
      },
    });
  }

  function joinOnline(code) {
    stopGame();
    game.roomCode = code;
    $('menu-msg').textContent = STR.connecting;
    RTS.net.join(code, {
      onPeer: () => { $('menu-msg').textContent = STR.waiting.replace('{code}', code); },
      onMsg: (m) => {
        if (!m) return;
        lastPeerMsg = performance.now();
        if (m.c === 'init') beginMatch('client', 1, m.seed);
        else if (m.c === 'snap') { RTS.render.view.push(m.s); checkOver(m.s); }
      },
      onClose: () => onPeerGone(),
      onError: (kind) => {
        $('menu-msg').textContent = kind === 'noroom' ? STR.noRoom : STR.netFail;
        show('menu');
      },
    });
  }

  function onPeerGone() {
    if (game.mode !== 'host' && game.mode !== 'client') return;
    if (game.overShown) return;
    game.overShown = true;
    showGameOver(true, STR.peerGone);
  }

  // ---------- game over ----------
  function checkOver(snap) {
    if (snap.over === -1 || game.overShown) return;
    game.overShown = true;
    const won = snap.over === game.myPlayer;
    showGameOver(won, null, snap.over === 2);
  }

  function showGameOver(won, subtitle, draw) {
    paused = false; game.paused = false;
    $('over-title').textContent = draw ? STR.draw : won ? STR.victory : STR.defeat;
    $('over-title').style.color = won && !draw ? RTS.PCOL[game.myPlayer].main : '#ff5050';
    $('over-sub').textContent = subtitle || '';
    show('over');
    if (draw) { /* no fanfare */ }
    else if (won) U.sfx.victory(); else U.sfx.defeat();
  }

  // ---------- HUD ----------
  function buildCommandCard() {
    const card = $('card');
    card.innerHTML = '';
    game.cardHotkeys = {};
    game.autoBtn = null; game.autoIds = [];
    const sel = RTS.input.selEnts();
    const info = $('sel-info');
    if (!sel.length) { info.textContent = ''; return; }

    const byKind = {};
    for (const e of sel) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    info.textContent = Object.entries(byKind)
      .map(([k, n]) => (n > 1 ? n + '× ' : '') + STR.names[k]).join(', ');
    // ●A badge appears while selected workers have auto-assist on
    const badge = document.createElement('span');
    badge.id = 'auto-badge'; badge.className = 'abadge';
    info.appendChild(badge);
    // kø-linje for valgt produktionsbygning (opdateres live i updateHudBar)
    const qline = document.createElement('span');
    qline.id = 'queue-line'; qline.className = 'qline';
    info.appendChild(qline);

    const addBtn = (label, cost, fn, cls, disabled) => {
      const b = document.createElement('button');
      b.className = 'cbtn' + (cls ? ' ' + cls : '');
      b.innerHTML = label + (cost ? `<span class="cost">${cost}</span>` : '');
      if (disabled) b.disabled = true;
      else b.addEventListener('click', (ev) => { ev.stopPropagation(); U.sfx.click(); fn(); });
      card.appendChild(b);
      return b;
    };

    const hasWorker = sel.some((e) => e.kind === 'worker');
    const units = sel.filter((e) => K[e.kind].unit);

    if (units.length) {
      addBtn('⚔ ' + STR.attackMove, 0, () => RTS.input.setAttackMod(true), 'wide');
      addBtn('✋ ' + STR.stop, 0, () => RTS.input.sendToSel('stop'));
    }
    if (hasWorker) {
      // AUTO: toggle auto-assist on the selected workers (hotkey F)
      const workerIds = sel.filter((e) => e.kind === 'worker').map((e) => e.id);
      const fn = () => {
        game.sendCmd({ c: 'auto', ids: workerIds, on: !allWorkersAuto(workerIds) });
      };
      game.autoBtn = addBtn('Ⓐ ' + STR.autoAssist + ' <span class="key">F</span>', 0, fn);
      game.autoIds = workerIds;
      if (allWorkersAuto(workerIds)) game.autoBtn.classList.add('active');
      game.cardHotkeys.KeyF = fn;
      for (const bk of ['rax', 'fact', 'turret', 'hq']) {
        addBtn('🔧 ' + STR.names[bk], K[bk].cost, () => {
          game.placing = { kind: bk, tx: 0, ty: 0, valid: false };
        });
      }
    }
    // single selected finished building → train buttons (hotkeys Q/W/E by slot)
    const trainKeys = ['KeyQ', 'KeyW', 'KeyE'];
    const b = sel.find((e) => K[e.kind].bld && !(e.flags & 2));
    if (b && K[b.kind].trains) {
      K[b.kind].trains.forEach((uk, slot) => {
        const fn = () => {
          const snap = RTS.render.view.next;
          if (snap && snap.res[game.myPlayer] < K[uk].cost) { U.sfx.error(); game.toast(STR.needCrystals); return; }
          if (snap && snap.sup[game.myPlayer] >= C.UNIT_CAP) { U.sfx.error(); game.toast(STR.atCap); return; }
          game.sendCmd({ c: 'train', tid: b.id, kind: uk });
        };
        const key = trainKeys[slot];
        addBtn('▲ ' + STR.names[uk] + (key ? ` <span class="key">${key.slice(3)}</span>` : ''), K[uk].cost, fn);
        if (key) game.cardHotkeys[key] = fn;
      });
    }
    // upgrades on a single selected finished building
    if (b) buildUpgradeButtons(addBtn, b);
  }

  // count selected workers whose snapshot row carries the auto flag (bit 32)
  function autoWorkerCount(ids) {
    const snap = RTS.render.view.next;
    if (!snap || !ids.length) return 0;
    const set = new Set(ids);
    let n = 0;
    for (const e of snap.e) if (set.has(e[0]) && (e[7] & 32)) n++;
    return n;
  }
  const allWorkersAuto = (ids) => ids.length > 0 && autoWorkerCount(ids) === ids.length;

  // player-tech + per-turret upgrade buttons (OWNED state once bought)
  function buildUpgradeButtons(addBtn, b) {
    const snap = RTS.render.view.next;
    const myTech = (snap && snap.tech) ? snap.tech[game.myPlayer] : 0;
    const buy = (cost, cmd) => () => {
      const s2 = RTS.render.view.next;
      if (s2 && s2.res[game.myPlayer] < cost) { U.sfx.error(); game.toast(STR.needCrystals); return; }
      game.sendCmd(cmd);
      game.toast(STR.upgradeBought);
      setTimeout(buildCommandCard, 350); // refresh to OWNED once the snapshot lands
    };
    const techFor = { hq: 'drill', rax: 'stims', fact: 'alloys' };
    const key = techFor[b.kind];
    if (key) {
      const t = RTS.TECH[key];
      const label = { drill: STR.upDrill, stims: STR.upStims, alloys: STR.upAlloys }[key];
      const owned = (myTech & t.bit) !== 0;
      const btn = owned
        ? addBtn('★ ' + label, STR.owned, null, '', true)
        : addBtn('★ ' + label, t.cost, buy(t.cost, { c: 'upgrade', tid: b.id, tech: key }));
      btn.title = STR.upDescr[key];
    } else if (b.kind === 'turret') {
      const owned = (b.flags & 16) !== 0;
      const btn = owned
        ? addBtn('★ ' + STR.upTurret, STR.owned, null, '', true)
        : addBtn('★ ' + STR.upTurret, RTS.TURRET_UP.cost, buy(RTS.TURRET_UP.cost, { c: 'upgrade', tid: b.id, tech: 'turret' }));
      btn.title = STR.upDescr.turret;
    }
  }

  function idleWorkerCount() {
    const snap = RTS.render.view.next;
    if (!snap) return 0;
    let n = 0;
    for (const e of snap.e) {
      // row: [id, kind, owner, ...flags@7]; flag 8 = idle worker
      if (e[2] === game.myPlayer && (e[7] & 8)) n++;
    }
    return n;
  }

  function updateHudBar() {
    const snap = RTS.render.view.next;
    if (!snap) return;
    $('hud-res').textContent = '◆ ' + snap.res[game.myPlayer];
    $('hud-sup').textContent = '⬢ ' + snap.sup[game.myPlayer] + '/' + C.UNIT_CAP;
    const idle = idleWorkerCount();
    const mineBtn = $('btn-mine');
    mineBtn.textContent = idle ? '⛏' + idle : '⛏';
    mineBtn.classList.toggle('has-idle', idle > 0);
    // live kø-status for valgt produktionsbygning: "kø: ▲▲● 63%"
    const qline = document.getElementById('queue-line');
    if (qline) {
      const sel = RTS.input.selEnts().filter((e) => K[e.kind].bld && K[e.kind].trains && e.owner === game.myPlayer);
      if (sel.length === 1 && sel[0].qlen > 0) {
        const b = sel[0];
        const glyph = { worker: '⛏', marine: '▲', brute: '■', mortar: '●', raider: '▶' }[KL[b.qkind]] || '?';
        qline.textContent = ' · ' + STR.queueLabel + ': ' + glyph.repeat(Math.min(b.qlen, 5)) + ' ' + Math.round(b.prog) + '%';
      } else {
        qline.textContent = '';
      }
    }
    // live auto-assist state (the command card is not rebuilt per snapshot)
    if (game.autoBtn && game.autoIds && game.autoIds.length) {
      const n = autoWorkerCount(game.autoIds);
      game.autoBtn.classList.toggle('active', n === game.autoIds.length);
      const badge = $('auto-badge');
      if (badge) badge.textContent = n > 0 ? ' ●A' : '';
    }
  }

  // ---------- boot ----------
  function boot() {
    const cvGame = $('game'), cvMm = $('minimap');
    RTS.render.initCanvas(cvGame, cvMm, $('gl'));
    RTS.input.init(game, cvGame, cvMm);

    $('btn-skirmish').addEventListener('click', () => { U.audio(); U.sfx.click(); startLocal(true); });

    // AI difficulty row (skirmish only; persisted in localStorage['rts-diff'])
    const diffBtns = { easy: $('btn-diff-easy'), normal: $('btn-diff-normal'), hard: $('btn-diff-hard') };
    const setDiff = (name) => {
      game.diff = name;
      try { localStorage.setItem('rts-diff', name); } catch (e) { /* storage blocked */ }
      for (const [k2, b2] of Object.entries(diffBtns)) b2.classList.toggle('active', k2 === name);
    };
    for (const k2 of Object.keys(diffBtns)) {
      diffBtns[k2].addEventListener('click', () => { U.sfx.click(); setDiff(k2); });
    }
    let diff0 = 'normal';
    try {
      const v = localStorage.getItem('rts-diff');
      if (RTS.AI_DIFF[v]) diff0 = v;
    } catch (e) { /* storage blocked */ }
    setDiff(diff0);
    $('diff-label').textContent = STR.diffLabel;
    diffBtns.easy.textContent = STR.diffEasy;
    diffBtns.normal.textContent = STR.diffNormal;
    diffBtns.hard.textContent = STR.diffHard;
    $('btn-host').addEventListener('click', () => { U.audio(); U.sfx.click(); show('menu'); hostOnline(); });
    $('btn-join').addEventListener('click', () => {
      U.audio(); U.sfx.click();
      const code = ($('join-code').value || '').trim().toUpperCase();
      if (code.length >= 3) joinOnline(code);
    });
    $('join-code').addEventListener('keydown', (e) => { if (e.code === 'Enter') $('btn-join').click(); });
    game.togglePause = () => setPaused(!paused);
    $('btn-menu').addEventListener('click', () => { U.sfx.click(); if (game.mode === 'menu') return; setPaused(true); });
    $('btn-resume').addEventListener('click', () => { U.sfx.click(); setPaused(false); });
    $('btn-pause-restart').addEventListener('click', () => { U.sfx.click(); startLocal(true); }); // stopGame() resets paused + game.paused
    $('btn-pause-quit').addEventListener('click', () => { U.sfx.click(); toMenu(); });
    $('btn-mute').addEventListener('click', () => {
      $('btn-mute').textContent = U.toggleMute() ? '🔇' : '🔊';
    });
    $('btn-amove').addEventListener('click', () => RTS.input.setAttackMod(true));
    $('btn-mine').title = STR.gatherIdle + ' (G)';
    $('btn-mine').addEventListener('click', () => {
      const n = idleWorkerCount();
      if (!n) { U.sfx.error(); game.toast(STR.noIdle); return; }
      RTS.input.gatherIdle();
      game.toast(STR.sentToMine);
    });
    $('btn-over-menu').addEventListener('click', () => { U.sfx.click(); toMenu(); });

    // menu strings from the active language table
    document.querySelector('#menu .tag').textContent = STR.tag;
    $('btn-skirmish').textContent = STR.skirmish;
    $('btn-host').textContent = STR.host;
    $('btn-join').textContent = STR.join;
    $('btn-over-menu').textContent = STR.backToMenu;
    document.querySelector('#menu summary').textContent = STR.howTitle;
    $('how-list').innerHTML = STR.how.map((l) => `<li>${l}</li>`).join('');
    document.documentElement.lang = RTS.LANG;
    $('hud-res').title = STR.crystals;
    $('hud-sup').title = STR.supply;
    $('btn-amove').title = STR.attackMove + ' (A)';
    $('btn-mute').title = STR.mute + ' (M)';
    $('btn-menu').title = STR.backToMenu;
    $('join-code').placeholder = STR.codePH;
    $('pause-title').textContent = STR.paused;
    $('btn-resume').textContent = STR.resume;
    $('btn-pause-restart').textContent = STR.restartGame;
    $('btn-pause-quit').textContent = STR.quitToMenu;

    // EN/DA toggle (persisted; English is the default)
    const langBtn = $('btn-lang');
    langBtn.textContent = STR.language + ': ' + (RTS.LANG === 'da' ? 'DA' : 'EN');
    langBtn.addEventListener('click', () => {
      U.sfx.click();
      try { localStorage.setItem('rts-lang', RTS.LANG === 'da' ? 'en' : 'da'); } catch (e) { /* storage blocked */ }
      location.reload();
    });

    const frame = () => {
      RTS.input.update(1 / 60);
      if (game.mode !== 'menu') {
        RTS.render.draw({
          cam: game.cam, sel: game.sel,
          placing: game.placing, drag: RTS.input.getDrag(),
        });
        updateHudBar();
        // selection may reference dead entities
        if (RTS.render.view.next) {
          const live = new Set(RTS.render.view.next.e.map((e) => e[0]));
          let changed = false;
          for (const id of game.sel) if (!live.has(id)) { game.sel.delete(id); changed = true; }
          if (changed) buildCommandCard();
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    show('menu');
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
