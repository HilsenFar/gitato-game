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
    game.mode = 'menu';
    $('hud').classList.remove('show');
    $('menu-msg').textContent = '';
    show('menu');
  }

  function stopGame() {
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
    if (vsAi) game.ai = RTS.ai.create(1);
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
      // authoritative loop (setInterval so the sim survives a hidden tab)
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
    const sel = RTS.input.selEnts();
    const info = $('sel-info');
    if (!sel.length) { info.textContent = ''; return; }

    const byKind = {};
    for (const e of sel) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    info.textContent = Object.entries(byKind)
      .map(([k, n]) => (n > 1 ? n + '× ' : '') + STR.names[k]).join(', ');

    const addBtn = (label, cost, fn, cls) => {
      const b = document.createElement('button');
      b.className = 'cbtn' + (cls ? ' ' + cls : '');
      b.innerHTML = label + (cost ? `<span class="cost">${cost}</span>` : '');
      b.addEventListener('click', (ev) => { ev.stopPropagation(); U.sfx.click(); fn(); });
      card.appendChild(b);
    };

    const hasWorker = sel.some((e) => e.kind === 'worker');
    const units = sel.filter((e) => K[e.kind].unit);

    if (units.length) {
      addBtn('⚔ ' + STR.attackMove, 0, () => RTS.input.setAttackMod(true), 'wide');
      addBtn('✋ ' + STR.stop, 0, () => RTS.input.sendToSel('stop'));
    }
    if (hasWorker) {
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
  }

  function updateHudBar() {
    const snap = RTS.render.view.next;
    if (!snap) return;
    $('hud-res').textContent = '◆ ' + snap.res[game.myPlayer];
    $('hud-sup').textContent = '⬢ ' + snap.sup[game.myPlayer] + '/' + C.UNIT_CAP;
  }

  // ---------- boot ----------
  function boot() {
    const cvGame = $('game'), cvMm = $('minimap');
    RTS.render.initCanvas(cvGame, cvMm, $('gl'));
    RTS.input.init(game, cvGame, cvMm);

    $('btn-skirmish').addEventListener('click', () => { U.audio(); U.sfx.click(); startLocal(true); });
    $('btn-host').addEventListener('click', () => { U.audio(); U.sfx.click(); show('menu'); hostOnline(); });
    $('btn-join').addEventListener('click', () => {
      U.audio(); U.sfx.click();
      const code = ($('join-code').value || '').trim().toUpperCase();
      if (code.length >= 3) joinOnline(code);
    });
    $('join-code').addEventListener('keydown', (e) => { if (e.code === 'Enter') $('btn-join').click(); });
    $('btn-menu').addEventListener('click', () => { U.sfx.click(); toMenu(); });
    $('btn-mute').addEventListener('click', () => {
      $('btn-mute').textContent = U.toggleMute() ? '🔇' : '🔊';
    });
    $('btn-amove').addEventListener('click', () => RTS.input.setAttackMod(true));
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
