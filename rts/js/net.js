// GITATO COMMAND — PeerJS networking (host-authoritative, 2 players)
'use strict';

RTS.net = (() => {
  const C = RTS.C;
  let peer = null, conn = null;
  let cbs = {};

  // default: PeerJS free cloud. Optional ?ps=host:port picks a self-hosted PeerServer.
  function serverOpts() {
    const ps = new URLSearchParams(location.search).get('ps');
    if (!ps) return { debug: 1 };
    const [h, p] = ps.split(':');
    const local = h === 'localhost' || h === '127.0.0.1';
    return { debug: 1, host: h, port: +p || (local ? 80 : 443), path: '/', secure: !local };
  }

  function destroy() {
    try { if (conn) conn.close(); } catch (e) { /* already closed */ }
    try { if (peer) peer.destroy(); } catch (e) { /* already destroyed */ }
    peer = null; conn = null; cbs = {};
  }

  function wireConn(c) {
    conn = c;
    conn.on('data', (msg) => { if (cbs.onMsg) cbs.onMsg(msg); });
    conn.on('close', () => { if (cbs.onClose) cbs.onClose(); });
    conn.on('error', () => { if (cbs.onClose) cbs.onClose(); });
  }

  // host a room; cb.onOpen(code), cb.onPeer(), cb.onMsg(msg), cb.onClose(), cb.onError(text)
  function host(code, callbacks) {
    destroy();
    cbs = callbacks;
    peer = new Peer(C.ROOM_PREFIX + code, serverOpts());
    peer.on('open', () => { if (cbs.onOpen) cbs.onOpen(code); });
    peer.on('connection', (c) => {
      if (conn) { try { c.close(); } catch (e) { /* room full */ } return; }
      wireConn(c);
      c.on('open', () => { if (cbs.onPeer) cbs.onPeer(); });
    });
    peer.on('error', (err) => {
      if (cbs.onError) cbs.onError(err && err.type === 'unavailable-id' ? 'taken' : 'net');
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* signaling lost */ } });
  }

  // join a room; cb.onPeer(), cb.onMsg(msg), cb.onClose(), cb.onError(text)
  function join(code, callbacks) {
    destroy();
    cbs = callbacks;
    peer = new Peer(serverOpts());
    peer.on('open', () => {
      const c = peer.connect(C.ROOM_PREFIX + code, { reliable: true });
      wireConn(c);
      c.on('open', () => { if (cbs.onPeer) cbs.onPeer(); });
    });
    peer.on('error', (err) => {
      if (cbs.onError) cbs.onError(err && err.type === 'peer-unavailable' ? 'noroom' : 'net');
    });
  }

  function send(msg) {
    if (conn && conn.open) {
      try { conn.send(msg); } catch (e) { /* channel closing */ }
    }
  }

  const connected = () => !!(conn && conn.open);

  return { host, join, send, destroy, connected };
})();
