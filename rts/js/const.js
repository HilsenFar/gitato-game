// GITATO COMMAND — game constants & balance tables
'use strict';

const RTS = {};

RTS.C = {
  TILE: 32,          // world units per tile
  MAP_W: 64,         // tiles
  MAP_H: 64,
  DT: 0.05,          // sim timestep (20 Hz)
  TICK_MS: 50,
  SNAP_EVERY: 2,     // host broadcasts every N ticks (10 Hz)
  UNIT_CAP: 60,
  START_CRYSTALS: 250,
  START_WORKERS: 4,
  CRYSTAL_AMOUNT: 1500,
  CARRY: 8,
  HARVEST_TIME: 2.0,
  ROOM_PREFIX: 'gitato-rts-v1-',
};

// kind ids are the index into this list (wire format uses the index)
RTS.KIND_LIST = ['worker', 'marine', 'brute', 'mortar', 'hq', 'rax', 'fact', 'turret', 'crystal'];

RTS.KINDS = {
  //                 cost hp   spd dmg rng  cd   sight aggro r
  worker: { unit: 1, cost: 50,  hp: 40,  spd: 78, dmg: 3,  rng: 18,  cd: 0.8, sight: 7, aggro: 0,   r: 8,  trainT: 8 },
  marine: { unit: 1, cost: 75,  hp: 60,  spd: 84, dmg: 9,  rng: 150, cd: 0.9, sight: 8, aggro: 190, r: 9,  trainT: 8,  proj: 'bolt' },
  brute:  { unit: 1, cost: 125, hp: 190, spd: 66, dmg: 16, rng: 24,  cd: 1.0, sight: 7, aggro: 150, r: 12, trainT: 12 },
  mortar: { unit: 1, cost: 200, hp: 90,  spd: 54, dmg: 26, rng: 230, cd: 2.2, sight: 9, aggro: 240, r: 11, trainT: 16, proj: 'shell', splash: 34, minRng: 70 },
  hq:     { bld: 1,  cost: 400, hp: 1600, fw: 3, fh: 3, sight: 9, buildT: 35, trains: ['worker'] },
  rax:    { bld: 1,  cost: 150, hp: 600,  fw: 2, fh: 2, sight: 6, buildT: 18, trains: ['marine', 'brute'] },
  fact:   { bld: 1,  cost: 250, hp: 700,  fw: 2, fh: 2, sight: 6, buildT: 25, trains: ['mortar'] },
  turret: { bld: 1,  cost: 100, hp: 350,  fw: 1, fh: 1, sight: 8, buildT: 12, rng: 170, dmg: 13, cd: 1.1, aggro: 175, proj: 'bolt' },
  crystal:{ res: 1,  hp: 1500, r: 11 },
};

RTS.PROJ_SPEED = { bolt: 420, shell: 260 };

// event kinds (wire format uses the index)
RTS.EV = { SHOT: 0, HIT: 1, BOOM: 2, BIGBOOM: 3, DEPOSIT: 4, BUILT: 5 };

// player colors: [main, glow, dim]
RTS.PCOL = [
  { main: '#00ffdc', glow: 'rgba(0,255,220,.5)',  dim: '#0a6e62' },
  { main: '#ff28b4', glow: 'rgba(255,40,180,.5)', dim: '#7a1458' },
];
RTS.NCOL = { main: '#50dc78', glow: 'rgba(80,220,120,.45)', dim: '#1d5a33' };

// player-visible strings (kept external so translation stays trivial)
RTS.STR = {
  title: 'GITATO COMMAND',
  tag: 'A neon micro-RTS. Destroy the enemy HQ.',
  skirmish: 'Skirmish vs AI',
  host: 'Host Online Game',
  join: 'Join Online Game',
  joinPrompt: 'Enter room code',
  waiting: 'Room code: {code} — waiting for opponent…',
  connecting: 'Connecting…',
  noRoom: 'Room not found. Check the code.',
  netFail: 'Connection failed. The signaling server may be unreachable.',
  peerGone: 'Opponent disconnected — you win by default.',
  victory: 'VICTORY',
  defeat: 'DEFEAT',
  youAre: 'You are {color}',
  cyan: 'CYAN', magenta: 'MAGENTA',
  backToMenu: 'Back to menu',
  playAgain: 'Rematch',
  crystals: 'crystals',
  supply: 'units',
  needCrystals: 'Not enough crystals',
  atCap: 'Unit cap reached',
  invalidSpot: 'Cannot build there',
  howTitle: 'How to play',
  how: [
    'Left-drag: select units. Right-click: move / attack / harvest.',
    'A + left-click: attack-move. S: stop. Esc: cancel.',
    'Workers harvest crystals and construct buildings.',
    'HQ trains workers. Barracks: marines & brutes. Factory: mortars.',
    'Arrows / edge / middle-drag pan the camera. Wheel zooms. M mutes.',
    'Destroy every enemy HQ to win.',
  ],
  names: {
    worker: 'Worker', marine: 'Marine', brute: 'Brute', mortar: 'Mortar',
    hq: 'HQ', rax: 'Barracks', fact: 'Factory', turret: 'Turret', crystal: 'Crystal',
  },
  descr: {
    worker: 'Harvests crystals, constructs buildings.',
    marine: 'Fast ranged trooper.',
    brute: 'Heavy melee bruiser.',
    mortar: 'Long-range splash artillery.',
    hq: 'Trains workers. Crystal drop-off. Protect it!',
    rax: 'Trains marines and brutes.',
    fact: 'Trains mortars.',
    turret: 'Static defense gun.',
  },
};
