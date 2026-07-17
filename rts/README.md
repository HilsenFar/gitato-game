# Gitato Command — multiplayer micro-RTS

A neon real-time strategy game that runs entirely in the browser at `/rts/`,
rendered in 3D with a tilted top-down camera in the spirit of Command & Conquer.
No build step, no binary art assets — every model is procedural Three.js
geometry with emissive neon materials, and all sound is synthesized with
WebAudio.

## Modes

- **Skirmish vs AI** — single-player against a bot that expands, builds an army
  and attacks in growing waves.
- **Online 1v1** — host gets a 4-letter room code, friend joins with it.
  Networking is peer-to-peer over WebRTC data channels (PeerJS, vendored in
  `vendor/`), using the free PeerJS cloud only for the initial handshake.
  Gameplay traffic never touches a server, so it works from a static host like
  GitHub Pages. Append `?ps=host:port` to use a self-hosted
  [PeerServer](https://github.com/peers/peerjs-server) instead of the cloud.

## Gameplay

Harvest crystals with workers, build Barracks / Factory / Turrets, train
marines, brutes and mortars, and destroy the enemy HQ. Fog of war, minimap,
drag-select, attack-move (`A`), rally points, and touch controls are all in.

## Architecture

The host is authoritative: it runs the whole simulation at 20 Hz and broadcasts
compact snapshots at 10 Hz; the other player only sends commands. The joining
client renders interpolated snapshots and never simulates, so the two sides
cannot desync. A 2 s heartbeat with a 10 s timeout declares victory if the
opponent vanishes (WebRTC close events alone are unreliable).

| File | Role |
| --- | --- |
| `js/const.js` | balance tables, strings, colors |
| `js/util.js`  | seeded RNG, math, WebAudio synth SFX |
| `js/map.js`   | symmetric map generation, A* pathfinding |
| `js/sim.js`   | authoritative simulation (economy, combat, construction) |
| `js/ai.js`    | skirmish bot |
| `js/net.js`   | PeerJS host/join wrapper |
| `js/scene3d.js`| Three.js scene: camera, procedural meshes, fog plane, picking |
| `js/render.js`| view layer: snapshot interpolation, fog of war, overlay HUD, minimap |
| `js/input.js` | selection, orders, camera, placement, touch |
| `js/main.js`  | menus, HUD, game loop, net glue |

Both peers generate the identical map from a shared seed; only entity state
travels over the wire.
