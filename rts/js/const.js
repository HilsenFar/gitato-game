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
  ROOM_PREFIX: 'gitato-rts-v3-',
};

// kind ids are the index into this list (wire format uses the index).
// INVARIANT: new kinds are only ever APPENDED at the end.
RTS.KIND_LIST = ['worker', 'marine', 'brute', 'mortar', 'hq', 'rax', 'fact', 'turret', 'crystal', 'raider'];

RTS.KINDS = {
  //                 cost hp   spd dmg rng  cd   sight aggro r
  worker: { unit: 1, cost: 50,  hp: 40,  spd: 78, dmg: 3,  rng: 18,  cd: 0.8, sight: 7, aggro: 0,   r: 8,  trainT: 8 },
  marine: { unit: 1, cost: 75,  hp: 60,  spd: 84, dmg: 9,  rng: 150, cd: 0.9, sight: 8, aggro: 190, r: 9,  trainT: 8,  proj: 'bolt' },
  brute:  { unit: 1, cost: 115, hp: 190, spd: 66, dmg: 16, rng: 24,  cd: 1.0, sight: 7, aggro: 150, r: 12, trainT: 12 },
  mortar: { unit: 1, cost: 200, hp: 90,  spd: 54, dmg: 26, rng: 230, cd: 2.2, sight: 9, aggro: 240, r: 11, trainT: 16, proj: 'shell', splash: 30, minRng: 70 },
  hq:     { bld: 1,  cost: 400, hp: 1600, fw: 3, fh: 3, sight: 9, buildT: 35, trains: ['worker'] },
  rax:    { bld: 1,  cost: 150, hp: 600,  fw: 2, fh: 2, sight: 6, buildT: 18, trains: ['marine', 'brute'] },
  fact:   { bld: 1,  cost: 250, hp: 700,  fw: 2, fh: 2, sight: 6, buildT: 25, trains: ['mortar', 'raider'] },
  turret: { bld: 1,  cost: 100, hp: 350,  fw: 1, fh: 1, sight: 8, buildT: 12, rng: 170, dmg: 14, cd: 1.1, aggro: 175, proj: 'bolt' },
  crystal:{ res: 1,  hp: 1500, r: 11 },
  // fast harass buggy: shreds workers/mortars, melts to brutes/turrets
  raider: { unit: 1, cost: 150, hp: 110, spd: 120, dmg: 10, rng: 90, cd: 0.7, sight: 8, aggro: 165, r: 10, trainT: 10, proj: 'bolt' },
};

RTS.PROJ_SPEED = { bolt: 420, shell: 260 };

// veterancy (combat units only — never workers)
RTS.VET = {
  kinds: ['marine', 'brute', 'mortar', 'raider'],
  kills: [3, 8],            // kills needed for rank 1 / rank 2
  dmg:   [1, 1.15, 1.30],   // damage multiplier per rank (from base)
  hp:    [1, 1.20, 1.40],   // maxhp multiplier per rank (from base)
};

// skirmish bot tuning
RTS.AI = {
  waveCap: 30,       // max army size that triggers an attack wave
  expandAt: 3000,    // expand when crystals near own HQs hold less than this
  harassSize: 3,     // raiders per harass squad
};

// event kinds (wire format uses the index)
RTS.EV = { SHOT: 0, HIT: 1, BOOM: 2, BIGBOOM: 3, DEPOSIT: 4, BUILT: 5, PROMOTE: 6 };

// player colors: [main, glow, dim]
RTS.PCOL = [
  { main: '#00ffdc', glow: 'rgba(0,255,220,.5)',  dim: '#0a6e62' },
  { main: '#ff28b4', glow: 'rgba(255,40,180,.5)', dim: '#7a1458' },
];
RTS.NCOL = { main: '#50dc78', glow: 'rgba(80,220,120,.45)', dim: '#1d5a33' };

// ---- player-visible strings ----
// English is the default; Danish is opt-in via the EN/DA menu toggle
// (persisted in localStorage['rts-lang']).
RTS.STR_EN = {
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
  draw: 'DRAW',
  youAre: 'You are {color}',
  cyan: 'CYAN', magenta: 'MAGENTA',
  backToMenu: 'Back to menu',
  playAgain: 'Rematch',
  room: 'room {code}',
  mute: 'Mute',
  codePH: 'CODE',
  crystals: 'crystals',
  supply: 'units',
  gatherIdle: 'Send idle workers to mine',
  noIdle: 'No idle workers',
  sentToMine: 'Idle workers → mining',
  needCrystals: 'Not enough crystals',
  atCap: 'Unit cap reached',
  invalidSpot: 'Cannot build there',
  attackMove: 'Attack-move',
  stop: 'Stop',
  howTitle: 'How to play',
  language: 'Language',
  how: [
    'Left-drag: select units. Right-click: move / attack / harvest.',
    'A + left-click: attack-move. S: stop. Esc: cancel.',
    'Workers harvest crystals and construct buildings — select several and place a building so they all build it together (faster).',
    'G (or the ⛏ button): send every idle worker back to mining.',
    'HQ trains workers. Barracks: marines & brutes. Factory: mortars & raiders.',
    'Combat units earn ranks: 3 kills → +15% dmg +20% hp, 8 kills → +30% / +40%.',
    'Arrows / edge / middle-drag pan the camera. Wheel zooms. M mutes.',
    'Destroy every enemy HQ to win.',
  ],
  names: {
    worker: 'Worker', marine: 'Marine', brute: 'Brute', mortar: 'Mortar',
    hq: 'HQ', rax: 'Barracks', fact: 'Factory', turret: 'Turret', crystal: 'Crystal',
    raider: 'Raider',
  },
  descr: {
    worker: 'Harvests crystals, constructs buildings.',
    marine: 'Fast ranged trooper.',
    brute: 'Heavy melee bruiser.',
    mortar: 'Long-range splash artillery.',
    hq: 'Trains workers. Crystal drop-off. Protect it!',
    rax: 'Trains marines and brutes.',
    fact: 'Trains mortars and raiders.',
    turret: 'Static defense gun.',
    raider: 'Fast harass buggy. Hunts workers and mortars; avoid brutes and turrets.',
  },
};

RTS.STR_DA = {
  title: 'GITATO COMMAND',
  tag: 'Et neon-mikro-RTS. Ødelæg fjendens HQ.',
  skirmish: 'Skirmish mod AI',
  host: 'Vær vært for onlinespil',
  join: 'Deltag i onlinespil',
  joinPrompt: 'Indtast rumkode',
  waiting: 'Rumkode: {code} — venter på modstander…',
  connecting: 'Forbinder…',
  noRoom: 'Rummet blev ikke fundet. Tjek koden.',
  netFail: 'Forbindelsen mislykkedes. Signalserveren er muligvis utilgængelig.',
  peerGone: 'Modstanderen forsvandt — du vinder.',
  victory: 'SEJR',
  defeat: 'NEDERLAG',
  draw: 'UAFGJORT',
  youAre: 'Du er {color}',
  cyan: 'CYAN', magenta: 'MAGENTA',
  backToMenu: 'Tilbage til menuen',
  playAgain: 'Revanche',
  room: 'rum {code}',
  mute: 'Lyd fra',
  codePH: 'KODE',
  crystals: 'krystaller',
  supply: 'enheder',
  gatherIdle: 'Send ledige workers i minen',
  noIdle: 'Ingen ledige workers',
  sentToMine: 'Ledige workers → høster',
  needCrystals: 'Ikke nok krystaller',
  atCap: 'Enhedsloftet er nået',
  invalidSpot: 'Kan ikke bygge dér',
  attackMove: 'Angrebsmarch',
  stop: 'Stop',
  howTitle: 'Sådan spiller du',
  language: 'Sprog',
  how: [
    'Venstre-træk: vælg enheder. Højreklik: flyt / angrib / høst.',
    'A + venstreklik: angrebsmarch. S: stop. Esc: annullér.',
    'Workers høster krystaller og bygger — vælg flere og placér en bygning, så bygger de den sammen (hurtigere).',
    'G (eller ⛏-knappen): send alle ledige workers tilbage i minen.',
    'HQ træner workers. Barracks: marines & brutes. Factory: mortars & raiders.',
    'Kampenheder får rang: 3 drab → +15% skade +20% hp, 8 drab → +30% / +40%.',
    'Pile / kanter / midterklik-træk panorerer. Hjul zoomer. M slår lyden fra.',
    'Ødelæg alle fjendens HQ’er for at vinde.',
  ],
  names: {
    worker: 'Worker', marine: 'Marine', brute: 'Brute', mortar: 'Mortar',
    hq: 'HQ', rax: 'Barracks', fact: 'Factory', turret: 'Turret', crystal: 'Krystal',
    raider: 'Raider',
  },
  descr: {
    worker: 'Høster krystaller og opfører bygninger.',
    marine: 'Hurtig afstandssoldat.',
    brute: 'Tung nærkampsbulderbasse.',
    mortar: 'Langtrækkende splash-artilleri.',
    hq: 'Træner workers. Krystal-aflevering. Beskyt det!',
    rax: 'Træner marines og brutes.',
    fact: 'Træner mortars og raiders.',
    turret: 'Stationær forsvarskanon.',
    raider: 'Hurtig harass-buggy. Jager workers og mortars; undgå brutes og turrets.',
  },
};

// active language: default English; localStorage may be unavailable (Node harness)
RTS.LANG = (() => {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('rts-lang') === 'da') return 'da';
  } catch (e) { /* storage blocked */ }
  return 'en';
})();
RTS.STR = RTS.LANG === 'da' ? RTS.STR_DA : RTS.STR_EN;
