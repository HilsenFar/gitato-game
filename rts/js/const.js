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
  ROOM_PREFIX: 'gitato-rts-v4-', // v4: upgrades/auto/rally-in-snapshot wire changes
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
  expandAt: 3000,    // expand when crystals near own HQs hold less than this
  harassSize: 3,     // raiders per harass squad
};

// AI difficulty presets (menu row under Skirmish; persisted in localStorage['rts-diff']).
// waveCap: max army size that triggers a wave. harassEvery: seconds between
// raider harass squads (0 = never). expand: may build expansion HQs.
// ecoEvery: economy/production decisions run every Nth think (1 = every).
// firstAttack: no attack waves before this many seconds. waveCommit: seconds a
// wave stays committed (also the minimum pause between waves). tech: buys the
// Mining Drill / Combat Stims upgrades when it can afford them.
// wave0: army size that triggers the FIRST attack wave (grows +4 up to waveCap)
// armyCap: stop training combat units above this size (0 = unlimited)
// turretCap: max defensive turrets the bot builds
// recall: abort a committed push to defend the base when it is under attack
RTS.AI_DIFF = {
  easy:   { wave0: 4,  waveCap: 10, armyCap: 4, turretCap: 0, harassEvery: 0,  expand: false, ecoEvery: 2, firstAttack: 300, waveCommit: 90, tech: false, recall: false },
  normal: { wave0: 8,  waveCap: 24, armyCap: 0, turretCap: 2, harassEvery: 90, expand: true,  ecoEvery: 1, firstAttack: 0,   waveCommit: 45, tech: false, recall: true },
  hard:   { wave0: 14, waveCap: 30, armyCap: 0, turretCap: 0, harassEvery: 60, expand: true,  ecoEvery: 1, firstAttack: 0,   waveCommit: 45, tech: true,  recall: true },
};

// one-time player technologies (s.tech[p] is a bitmask), bought from the named
// building via {c:'upgrade', tid, tech}. Turret Overcharge is per-turret (e.up).
RTS.TECH = {
  drill:  { bit: 1, cost: 300, bld: 'hq',   carry: 12 },                              // worker carry 8 -> 12
  stims:  { bit: 2, cost: 250, bld: 'rax',  kinds: ['marine', 'brute'],  dmgMul: 1.10 },
  alloys: { bit: 4, cost: 250, bld: 'fact', kinds: ['mortar', 'raider'], hpMul: 1.20 }, // retrofits existing units
};
RTS.TURRET_UP = { cost: 100, mul: 1.5 };   // per-turret: +50% dmg / rng / hp

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
  paused: 'PAUSED',
  resume: 'Resume',
  restartGame: 'Restart',
  quitToMenu: 'Quit to menu',
  pauseMpNote: 'The game keeps running in online matches',
  needCrystals: 'Not enough crystals',
  atCap: 'Unit cap reached',
  invalidSpot: 'Cannot build there',
  attackMove: 'Attack-move',
  stop: 'Stop',
  howTitle: 'How to play',
  language: 'Language',
  diffLabel: 'AI',
  diffEasy: 'EASY', diffNormal: 'NORMAL', diffHard: 'HARD',
  upDrill: 'Mining Drill', upStims: 'Combat Stims', upAlloys: 'Hardened Alloys', upTurret: 'Overcharge',
  owned: 'OWNED',
  upgradeBought: 'Upgrade purchased',
  autoAssist: 'Auto-assist',
  rallySet: 'Rally point set',
  upDescr: {
    drill: 'Workers carry 12 crystals instead of 8.',
    stims: 'Marines and brutes deal +10% damage.',
    alloys: 'Mortars and raiders get +20% max hp (existing units too).',
    turret: 'This turret: +50% damage, range and hp.',
  },
  how: [
    'Left-drag: select units. Shift-click / Shift-drag adds to the selection. Right-click: move / attack / harvest.',
    'A + left-click: attack-move. S: stop. Esc: cancel selection / pause menu.',
    'Workers harvest crystals and construct buildings — select several and place a building so they all build it together (faster). Right-click an unfinished building to send workers to it.',
    'G (or the ⛏ button): send every idle worker back to mining. Workers spread out automatically — max 2 per crystal.',
    'F (or the Ⓐ button) toggles auto-assist on workers: when idle they join the nearest construction site or find a free crystal by themselves.',
    'HQ trains workers. Barracks: marines & brutes. Factory: mortars & raiders. Q/W/E are train hotkeys on a selected building.',
    'Rally points: right-click with a production building selected. Rally the HQ on a crystal and new workers start mining it automatically.',
    'Upgrades: select the HQ (Mining Drill), Barracks (Combat Stims), Factory (Hardened Alloys) or a Turret (Overcharge) and buy from the command card.',
    'Combat units earn ranks: 3 kills → +15% dmg +20% hp, 8 kills → +30% / +40%.',
    'The minimap shows crystal fields as green dots — click or drag it to pan. Arrows / edge / middle-drag pan too. Wheel zooms. M mutes.',
    'Skirmish: pick the AI difficulty (EASY / NORMAL / HARD) under the Skirmish button.',
    'Touch: tap to select, tap to order, long-press for attack-move, two fingers to pan/zoom.',
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
  paused: 'PAUSE',
  resume: 'Fortsæt',
  restartGame: 'Genstart',
  quitToMenu: 'Til menuen',
  pauseMpNote: 'Spillet fortsætter i online-kampe',
  needCrystals: 'Ikke nok krystaller',
  atCap: 'Enhedsloftet er nået',
  invalidSpot: 'Kan ikke bygge dér',
  attackMove: 'Angrebsmarch',
  stop: 'Stop',
  howTitle: 'Sådan spiller du',
  language: 'Sprog',
  diffLabel: 'AI',
  diffEasy: 'LET', diffNormal: 'NORMAL', diffHard: 'SVÆR',
  upDrill: 'Mining Drill', upStims: 'Combat Stims', upAlloys: 'Hardened Alloys', upTurret: 'Overcharge',
  owned: 'EJET',
  upgradeBought: 'Opgradering købt',
  autoAssist: 'Auto-hjælp',
  rallySet: 'Samlingspunkt sat',
  upDescr: {
    drill: 'Workers bærer 12 krystaller i stedet for 8.',
    stims: 'Marines og brutes giver +10% skade.',
    alloys: 'Mortars og raiders får +20% max hp (også eksisterende enheder).',
    turret: 'Denne turret: +50% skade, rækkevidde og hp.',
  },
  how: [
    'Venstre-træk: vælg enheder. Shift-klik / Shift-træk føjer til valget. Højreklik: flyt / angrib / høst.',
    'A + venstreklik: angrebsmarch. S: stop. Esc: annullér valg / pausemenu.',
    'Workers høster krystaller og bygger — vælg flere og placér en bygning, så bygger de den sammen (hurtigere). Højreklik på en ufærdig bygning for at sende workers derhen.',
    'G (eller ⛏-knappen): send alle ledige workers tilbage i minen. Workers fordeler sig selv — max 2 pr. krystal.',
    'F (eller Ⓐ-knappen) slår auto-hjælp til på workers: når de er ledige, hjælper de selv med nærmeste byggeplads eller finder en fri krystal.',
    'HQ træner workers. Barracks: marines & brutes. Factory: mortars & raiders. Q/W/E er træn-genveje på en valgt bygning.',
    'Samlingspunkter: højreklik med en valgt produktionsbygning. Sæt HQ’ets samlingspunkt på en krystal, så høster nye workers den automatisk.',
    'Opgraderinger: vælg HQ (Mining Drill), Barracks (Combat Stims), Factory (Hardened Alloys) eller en Turret (Overcharge) og køb på kommandokortet.',
    'Kampenheder får rang: 3 drab → +15% skade +20% hp, 8 drab → +30% / +40%.',
    'Minimappet viser krystalfelter som grønne prikker — klik eller træk i det for at panorere. Pile / kanter / midterklik-træk panorerer også. Hjul zoomer. M slår lyden fra.',
    'Skirmish: vælg AI-sværhedsgrad (LET / NORMAL / SVÆR) under Skirmish-knappen.',
    'Touch: tryk for at vælge og give ordrer, langt tryk = angrebsmarch, to fingre panorerer/zoomer.',
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
