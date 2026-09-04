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
      if (game.mode === 'replay') return; // spectator — orders go nowhere
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
    disarmHistory(); // every exit path passes through here, so no stale back-entry survives
    stopGame();
    paused = false; game.paused = false;
    game.mode = 'menu';
    $('hud').classList.remove('show');
    $('menu-msg').textContent = '';
    show('menu');
  }

  function stopGame() {
    paused = false; game.paused = false; // every teardown path must resync both pause flags
    netPending(false); // drop the 'Connecting…' timeout and its Cancel button
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    RTS.net.destroy();
    RTS.replay.abort(); // a game quit mid-match records nothing
    RTS.replay.stop();
    game.replayPaused = false;
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

  // one sim tick: live modes gather+record commands, replay feeds the log back
  function simTick() {
    let cmds;
    if (game.mode === 'replay') {
      cmds = RTS.replay.cmdsFor(game.sim.tick);
    } else {
      cmds = game.pending.concat(game.remote);
      game.pending = []; game.remote = [];
      if (game.ai) cmds.push(...RTS.ai.think(game.ai, game.sim));
      RTS.replay.record(game.sim.tick, cmds);
    }
    RTS.sim.step(game.sim, cmds);
    // replay at N× stretches the snapshot cadence so pushes stay ~10 Hz real
    // time — pushing bursts of snapshots per interval makes motion judder.
    // Always snapshot a finished game: if the final HQ falls on an off-cadence
    // tick, step() early-returns forever after and the tick never reaches the
    // next boundary — without this the over panel never shows.
    const snapEvery = game.mode === 'replay' ? C.SNAP_EVERY * (game.replaySpeed || 1) : C.SNAP_EVERY;
    if (game.sim.tick % snapEvery === 0 || (game.sim.over !== -1 && !game.overShown)) {
      const snap = RTS.sim.snapshot(game.sim);
      RTS.render.view.push(snap);
      if (game.mode === 'host') RTS.net.send({ c: 'snap', s: snap });
      checkOver(snap);
    }
  }

  // authoritative loop (setInterval so the sim survives a hidden tab)
  function startSimLoop() {
    if (simTimer) return;
    simTimer = setInterval(() => {
      if (game.mode !== 'replay') { simTick(); return; }
      // replay: ⏸ + speed multiplier + end/drift handling
      if (game.replayPaused || game.overShown || !game.sim) return;
      const rep = RTS.replay.current();
      for (let i = 0; i < (game.replaySpeed || 1) && !game.overShown; i++) {
        simTick();
        if (!rep || game.sim.over !== -1) continue; // checkOver ends it on the next snap
        if (rep.reason !== 'over' && game.sim.tick >= rep.endTick) {
          // the recording ended by disconnect, not by an HQ falling
          game.overShown = true;
          showReplayEnd(rep.winner, false);
        } else if (game.sim.tick > rep.endTick + 400) {
          // 20 s past the recorded end with no result: playback drifted
          game.overShown = true;
          showReplayEnd(rep.winner, true);
        }
      }
    }, C.TICK_MS);
  }

  // ---- pause (ESC / ☰) — skirmish & replay can freeze the sim; online keeps running ----
  let paused = false;

  // Android / browser back: the first press pauses, the second quits. One
  // history entry is armed while a match runs; every exit path ends in
  // toMenu(), which disarms it, so no stale entry is left behind.
  let histArmed = false;
  function armHistory() { if (!histArmed) { histArmed = true; history.pushState({ rts: true }, ''); } }
  function disarmHistory() { if (histArmed) { histArmed = false; if (history.state && history.state.rts) history.back(); } }
  window.addEventListener('popstate', () => {
    if (game.mode === 'menu') return;
    histArmed = false; // the press consumed the entry
    if (settingsOpen()) { closeSettings(); armHistory(); return; }    // settings: one level up, to the pause menu
    if (!paused && !game.overShown) { setPaused(true); armHistory(); } // 1st press: pause
    else toMenu();                                                    // 2nd press (or after game over): quit
  });

  function setPaused(on) {
    if (game.mode === 'menu') return;
    if (game.overShown) return; // ESC/burger must not replace the results panel after game over
    if (paused === on) return;
    paused = on;
    game.paused = on;
    const canFreeze = game.mode === 'skirmish' || game.mode === 'replay';
    if (on) {
      $('btn-pause-restart').style.display = canFreeze ? '' : 'none';
      $('pause-note').textContent = canFreeze ? '' : STR.pauseMpNote;
      show('pause');
      if (canFreeze && simTimer) { clearInterval(simTimer); simTimer = null; }
    } else {
      show(null);
      if (canFreeze) startSimLoop();
    }
  }

  // ---- settings (opened from the pause menu; ESC / back returns to it) ----
  const settingsOpen = () => $('settings').classList.contains('show');
  function syncSoundLabel() {
    // #btn-mute mirrors U.toggleMute() (button + M key), so it is the one source of the muted state
    const muted = $('btn-mute').classList.contains('is-muted');
    $('btn-set-sound').textContent = STR.sound + ': ' + (muted ? STR.off : STR.on);
  }
  function openSettings() {
    if (!paused) return;
    syncSoundLabel();
    $('set-diffrow').style.display = game.mode === 'skirmish' ? '' : 'none'; // only skirmish has a bot
    show('settings');
    $('btn-set-sound').focus();
  }
  function closeSettings() {
    show('pause');
    $('btn-pause-settings').focus();
  }

  function beginMatch(mode, myPlayer, seed) {
    netPending(false); // the online handshake is over
    game.mode = mode;
    game.myPlayer = myPlayer;
    game.seed = seed;
    game.map = RTS.map.generate(seed);
    RTS.render.setMap(game.map, myPlayer);
    if (mode !== 'client') game.sim = RTS.sim.init(seed);
    // record on the simulating side (client plays back the host's stream)
    if (mode === 'skirmish' || mode === 'host') {
      RTS.replay.begin(mode, seed, mode === 'skirmish' ? game.diff : null);
    }

    // camera centered on own base (cam.x/y = ground point at screen center)
    const st = game.map.starts[myPlayer];
    game.cam.zoom = 1;
    game.cam.x = st.tx * C.TILE;
    game.cam.y = st.ty * C.TILE;

    show(null);
    $('hud').classList.add('show');
    // colour by class (.p0/.p1/.replay in style.css), never a raw hex on text
    const hc = $('hud-color');
    hc.classList.remove('p0', 'p1', 'replay');
    if (mode === 'replay') {
      hc.textContent = STR.replayLabel;
      hc.classList.add('replay');
    } else {
      hc.textContent = STR.youAre.replace('{color}', myPlayer === 0 ? STR.cyan : STR.magenta);
      hc.classList.add('p' + myPlayer);
    }
    $('hud-room').textContent = game.roomCode && (mode === 'host' || mode === 'client') ? STR.room.replace('{code}', game.roomCode) : '';
    $('replaybar').classList.toggle('show', mode === 'replay');
    // order buttons are meaningless for a spectator (and crowd the topbar)
    $('btn-mine').style.display = mode === 'replay' ? 'none' : '';
    $('btn-amove').style.display = mode === 'replay' ? 'none' : '';
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
    armHistory();
  }

  // ---------- online ----------
  // 'Connecting…' can hang forever: a signaling socket that never answers
  // raises no PeerJS error. So every pending connect carries a timeout and a
  // Cancel button. netSettled() stops the clock once the server has answered
  // (a host waiting for an opponent keeps Cancel); netPending(false) clears
  // both — called from stopGame() and beginMatch().
  let netTimer = null;
  function netPending(on) {
    clearTimeout(netTimer); netTimer = null;
    $('btn-cancel').hidden = !on;
    if (!on) return;
    netTimer = setTimeout(() => {
      if (game.mode !== 'menu') return;
      stopGame();
      game.roomCode = '';
      $('menu-msg').textContent = STR.netTimeout;
    }, C.NET_TIMEOUT_MS);
  }
  function netSettled() { clearTimeout(netTimer); netTimer = null; }

  function hostOnline() {
    stopGame();
    const code = U.roomCode(4);
    game.roomCode = code;
    $('menu-msg').textContent = STR.connecting;
    netPending(true);
    RTS.net.host(code, {
      onOpen: () => { netSettled(); $('menu-msg').textContent = STR.waiting.replace('{code}', code); },
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
        else netPending(false);
      },
    });
  }

  function joinOnline(code) {
    stopGame();
    game.roomCode = code;
    $('menu-msg').textContent = STR.connecting;
    netPending(true);
    RTS.net.join(code, {
      onPeer: () => { netSettled(); $('menu-msg').textContent = STR.waiting.replace('{code}', code); },
      onMsg: (m) => {
        if (!m) return;
        lastPeerMsg = performance.now();
        if (m.c === 'init') beginMatch('client', 1, m.seed);
        else if (m.c === 'snap') { RTS.render.view.push(m.s); checkOver(m.s); }
        else if (m.c === 'replay') {
          // the host shares the finished game's replay with the client — but
          // peer data is untrusted: only accept it once the game actually
          // ended, and never persist absurd payloads
          if (!game.overShown) return;
          let size = 0;
          try { size = JSON.stringify(m.data).length; } catch (e) { return; }
          if (size > 2000000) return;
          const rep = RTS.replay.validate(m.data);
          if (rep) { lastRep = rep; RTS.replay.storeLast(rep); $('btn-save-replay').style.display = ''; }
        }
      },
      onClose: () => onPeerGone(),
      onError: (kind) => {
        if (game.mode !== 'menu') return; // mid-match: the heartbeat ends the game; never drop the menu over the HUD
        netPending(false);
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
    finishRecording(game.myPlayer, 'disconnect'); // survivor wins by default
  }

  // ---------- game over ----------
  function checkOver(snap) {
    if (snap.over === -1 || game.overShown) return;
    game.overShown = true;
    if (game.mode === 'replay') {
      // faithful playback ends with exactly the recorded winner at exactly the
      // recorded tick; anything else — and a 'disconnect' recording reaching a
      // sim game-over at all — means the sim diverged from the recording
      const rep = RTS.replay.current();
      const drifted = !!rep && (rep.reason !== 'over' || snap.over !== rep.winner || game.sim.tick !== rep.endTick);
      showReplayEnd(snap.over, drifted);
      return;
    }
    const won = snap.over === game.myPlayer;
    showGameOver(won, null, snap.over === 2);
    finishRecording(snap.over, 'over');
  }

  // close the recording, keep it for the save button, remember it as the last
  // game, and hand the client a copy over the wire (old clients ignore it)
  let lastRep = null;
  function finishRecording(winner, reason) {
    const rep = RTS.replay.finish(winner, game.sim ? game.sim.tick : 0, reason);
    if (!rep) return; // nothing was recording (client / replay)
    lastRep = rep;
    RTS.replay.storeLast(rep);
    if (game.mode === 'host') RTS.net.send({ c: 'replay', data: rep });
    $('btn-save-replay').style.display = '';
  }

  function showGameOver(won, subtitle, draw) {
    paused = false; game.paused = false;
    $('over-title').textContent = draw ? STR.draw : won ? STR.victory : STR.defeat;
    $('over-title').className = 'sheet-title ' + (won && !draw ? 'p' + game.myPlayer : 'lost');
    $('over-sub').textContent = subtitle || '';
    $('btn-save-replay').style.display = 'none'; // finishRecording unhides it
    show('over');
    if (draw) { /* no fanfare */ }
    else if (won) U.sfx.victory(); else U.sfx.defeat();
  }

  // ---------- replays ----------
  function showReplayEnd(winner, drifted) {
    paused = false; game.paused = false;
    game.replayPaused = true;
    $('over-title').textContent = STR.replayEnded;
    $('over-title').className = 'sheet-title replay';
    const who = winner === 2 ? STR.draw
      : STR.replayWinnerIs.replace('{color}', winner === 0 ? STR.cyan : STR.magenta);
    $('over-sub').textContent = who + (drifted ? ' — ' + STR.replayDrift : '');
    $('btn-save-replay').style.display = 'none';
    show('over');
  }

  function startReplay(rep) {
    stopGame();
    const comp = RTS.replay.compat(rep);
    RTS.replay.start(rep);
    game.replaySpeed = 1;
    game.replayPaused = false;
    setReplaySpeedUI();
    beginMatch('replay', 0, rep.seed);
    RTS.render.setReveal(true); // spectators see through the fog
    if (comp !== 'ok') game.toast(STR.replayVersion);
  }

  function setReplaySpeedUI() {
    for (const sp of [1, 2, 4]) $('btn-rp-' + sp).classList.toggle('active', (game.replaySpeed || 1) === sp);
    $('btn-rp-pause').classList.toggle('is-paused', !!game.replayPaused); // swaps the pause/play sprite
  }

  // ---------- HUD ----------
  // sprite icon from rts/icons.svg — the card used to lead with emoji (⚔ ✋ 🔧 …)
  const gi = (name) => `<svg class="gi" aria-hidden="true" focusable="false"><use href="icons.svg#gi-${name}"></use></svg>`;
  const count = (id) => $(id).querySelector('.count'); // the number next to a sprite

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

    // replay spectators inspect but never command — no buttons, no false toasts
    if (game.mode === 'replay') return;

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
      addBtn(gi('sword') + STR.attackMove, 0, () => RTS.input.setAttackMod(true), 'wide');
      addBtn(gi('stop') + STR.stop, 0, () => RTS.input.sendToSel('stop'));
    }
    if (hasWorker) {
      // AUTO: toggle auto-assist on the selected workers (hotkey F)
      const workerIds = sel.filter((e) => e.kind === 'worker').map((e) => e.id);
      const fn = () => {
        game.sendCmd({ c: 'auto', ids: workerIds, on: !allWorkersAuto(workerIds) });
      };
      game.autoBtn = addBtn(gi('refresh') + STR.autoAssist + ' <span class="key">F</span>', 0, fn);
      game.autoIds = workerIds;
      if (allWorkersAuto(workerIds)) game.autoBtn.classList.add('active');
      game.cardHotkeys.KeyF = fn;
      for (const bk of ['rax', 'fact', 'turret', 'hq']) {
        addBtn(gi('wrench') + STR.names[bk], K[bk].cost, () => {
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
        addBtn(gi('target') + STR.names[uk] + (key ? ` <span class="key">${key.slice(3)}</span>` : ''), K[uk].cost, fn);
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
        ? addBtn(gi('star') + label, STR.owned, null, '', true)
        : addBtn(gi('star') + label, t.cost, buy(t.cost, { c: 'upgrade', tid: b.id, tech: key }));
      btn.title = STR.upDescr[key];
    } else if (b.kind === 'turret') {
      const owned = (b.flags & 16) !== 0;
      const btn = owned
        ? addBtn(gi('star') + STR.upTurret, STR.owned, null, '', true)
        : addBtn(gi('star') + STR.upTurret, RTS.TURRET_UP.cost, buy(RTS.TURRET_UP.cost, { c: 'upgrade', tid: b.id, tech: 'turret' }));
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
    if (game.mode === 'replay') { // spectators see both economies
      count('hud-res').textContent = snap.res[0] + ' · ' + snap.res[1];
      count('hud-sup').textContent = snap.sup[0] + ' · ' + snap.sup[1];
    } else {
      count('hud-res').textContent = snap.res[game.myPlayer];
      count('hud-sup').textContent = snap.sup[game.myPlayer] + '/' + C.UNIT_CAP;
    }
    const idle = idleWorkerCount();
    const mineBtn = $('btn-mine');
    count('btn-mine').textContent = idle ? String(idle) : '';
    mineBtn.classList.toggle('has-idle', idle > 0);
    // live kø-status for valgt produktionsbygning: "kø: ▲▲● 63%"
    const qline = document.getElementById('queue-line');
    if (qline) {
      const sel = RTS.input.selEnts().filter((e) => K[e.kind].bld && K[e.kind].trains
        && (game.mode === 'replay' ? e.owner < 2 : e.owner === game.myPlayer));
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
    // history.state survives a reload: a match's armed back-entry must not
    // outlive the match, or leaving the site takes one extra back press
    if (history.state && history.state.rts) history.back();

    $('btn-skirmish').addEventListener('click', () => { U.audio(); U.sfx.click(); startLocal(true); });

    // AI difficulty row (skirmish only; persisted in localStorage['rts-diff']).
    // The same row sits in the settings panel; both stay in step.
    const diffBtns = { easy: $('btn-diff-easy'), normal: $('btn-diff-normal'), hard: $('btn-diff-hard') };
    const setDiffBtns = { easy: $('btn-set-diff-easy'), normal: $('btn-set-diff-normal'), hard: $('btn-set-diff-hard') };
    const setDiff = (name) => {
      game.diff = name;
      try { localStorage.setItem('rts-diff', name); } catch (e) { /* storage blocked */ }
      for (const [k2, b2] of Object.entries(diffBtns)) b2.classList.toggle('active', k2 === name);
      for (const [k2, b2] of Object.entries(setDiffBtns)) b2.classList.toggle('active', k2 === name);
      // changed mid-skirmish (settings panel): the running bot switches presets (ai.js reads ai.d every think)
      if (game.ai && game.mode === 'skirmish') { game.ai.diff = name; game.ai.d = RTS.AI_DIFF[name]; }
    };
    for (const k2 of Object.keys(diffBtns)) {
      diffBtns[k2].addEventListener('click', () => { U.sfx.click(); setDiff(k2); });
      setDiffBtns[k2].addEventListener('click', () => { U.sfx.click(); setDiff(k2); });
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
    $('set-diff-label').textContent = STR.diffLabel;
    setDiffBtns.easy.textContent = STR.diffEasy;
    setDiffBtns.normal.textContent = STR.diffNormal;
    setDiffBtns.hard.textContent = STR.diffHard;
    // replays: last game from localStorage, or any saved .json file
    $('btn-replay').addEventListener('click', () => {
      if (game.mode !== 'menu') return;
      U.audio(); U.sfx.click();
      const rep = RTS.replay.loadLast();
      if (!rep) { game.toast(STR.replayNone); return; }
      startReplay(rep);
    });
    $('btn-replay-load').addEventListener('click', () => {
      if (game.mode !== 'menu') return;
      U.sfx.click(); $('replay-file').click();
    });
    $('replay-file').addEventListener('change', (ev) => {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = ''; // re-selecting the same file must fire again
      if (!f) return;
      f.text().then((txt) => {
        // a match may have started while the OS file dialog was open (e.g. a
        // waiting host got joined) — starting the replay now would tear it down
        if (game.mode !== 'menu') return;
        let rep = null;
        try { rep = RTS.replay.validate(JSON.parse(txt)); } catch (e) { /* not JSON */ }
        if (!rep) { U.sfx.error(); game.toast(STR.replayBad); return; }
        U.audio();
        startReplay(rep);
      });
    });
    $('btn-save-replay').addEventListener('click', () => { U.sfx.click(); if (lastRep) RTS.replay.download(lastRep); });
    $('btn-rp-pause').addEventListener('click', () => {
      U.sfx.click();
      game.replayPaused = !game.replayPaused;
      setReplaySpeedUI();
    });
    for (const sp of [1, 2, 4]) {
      $('btn-rp-' + sp).addEventListener('click', () => { U.sfx.click(); game.replaySpeed = sp; setReplaySpeedUI(); });
    }

    $('btn-host').addEventListener('click', () => { U.audio(); U.sfx.click(); show('menu'); hostOnline(); });
    $('btn-join').addEventListener('click', () => {
      U.audio(); U.sfx.click();
      const code = ($('join-code').value || '').trim().toUpperCase();
      if (code.length >= 3) joinOnline(code);
    });
    $('join-code').addEventListener('keydown', (e) => { if (e.code === 'Enter') $('btn-join').click(); });
    // ESC (js/input.js): settings open → back to the pause menu; otherwise pause / resume
    game.togglePause = () => { if (settingsOpen()) closeSettings(); else setPaused(!paused); };
    $('btn-menu').addEventListener('click', () => { U.sfx.click(); if (game.mode === 'menu') return; setPaused(true); });
    $('btn-resume').addEventListener('click', () => { U.sfx.click(); setPaused(false); });
    $('btn-pause-settings').addEventListener('click', () => { U.sfx.click(); openSettings(); });
    $('btn-set-back').addEventListener('click', () => { U.sfx.click(); closeSettings(); });
    $('btn-set-sound').addEventListener('click', () => {
      const m = U.toggleMute();
      $('btn-mute').classList.toggle('is-muted', m); // swaps the speaker/mute sprite in the HUD
      syncSoundLabel();
      if (!m) U.sfx.click(); // audible confirmation only when sound comes back
    });
    $('btn-pause-restart').addEventListener('click', () => { // stopGame() resets paused + game.paused
      U.sfx.click();
      const rep = game.mode === 'replay' ? RTS.replay.current() : null;
      if (rep) startReplay(rep); else startLocal(true);
    });
    $('btn-pause-quit').addEventListener('click', () => { U.sfx.click(); toMenu(); });
    $('btn-cancel').addEventListener('click', () => { // abandon a pending host/join
      U.sfx.click();
      if (game.mode !== 'menu') return;
      stopGame();
      game.roomCode = '';
      $('menu-msg').textContent = '';
    });
    $('btn-mute').addEventListener('click', () => {
      $('btn-mute').classList.toggle('is-muted', U.toggleMute()); // swaps the speaker/mute sprite
    });
    $('btn-amove').addEventListener('click', () => RTS.input.setAttackMod(true));
    $('btn-mine').title = STR.gatherIdle + ' (G)';
    $('btn-mine').addEventListener('click', () => {
      if (game.mode === 'replay') return; // spectators issue no orders
      const n = idleWorkerCount();
      if (!n) { U.sfx.error(); game.toast(STR.noIdle); return; }
      RTS.input.gatherIdle();
      game.toast(STR.sentToMine);
    });
    $('btn-over-menu').addEventListener('click', () => { U.sfx.click(); toMenu(); });
    // a reload or a closed tab mid-match ends the online game for both sides — ask first
    window.addEventListener('beforeunload', (e) => {
      if ((game.mode === 'host' || game.mode === 'client') && !game.overShown) { e.preventDefault(); e.returnValue = ''; }
    });

    // menu strings from the active language table
    document.querySelector('#menu .tag').textContent = STR.tag;
    $('btn-skirmish').textContent = STR.skirmish;
    $('btn-host').textContent = STR.host;
    $('btn-join').textContent = STR.join;
    $('btn-replay').textContent = STR.replayLast;
    $('btn-replay-load').textContent = STR.replayLoad;
    $('btn-save-replay').textContent = STR.saveReplay;
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
    $('btn-cancel').textContent = STR.cancel;
    $('btn-pause-settings').textContent = STR.settings;
    $('settings-title').textContent = STR.settings;
    $('btn-set-back').textContent = STR.back;
    $('settings-note').textContent = STR.langNote;
    syncSoundLabel();

    // EN/DA toggle (persisted; English is the default) — in the menu and in the
    // pause-menu settings; the reload ends a running match, which the settings
    // note says
    const switchLang = () => {
      U.sfx.click();
      try { localStorage.setItem('rts-lang', RTS.LANG === 'da' ? 'en' : 'da'); } catch (e) { /* storage blocked */ }
      location.reload();
    };
    for (const lb of [$('btn-lang'), $('btn-set-lang')]) {
      lb.textContent = STR.language + ': ' + (RTS.LANG === 'da' ? 'DA' : 'EN');
      lb.addEventListener('click', switchLang);
    }

    const frame = () => {
      RTS.input.update(1 / 60);
      if (game.mode !== 'menu') {
        RTS.render.draw({
          cam: game.cam, sel: game.sel,
          placing: game.placing, drag: RTS.input.getDrag(),
          paused: paused || !!game.replayPaused,
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
