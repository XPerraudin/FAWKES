// All shared mutable simulation state exported as a single object; also exports canvas/ctx.

export const canvas = document.getElementById('simCanvas');
export const ctx    = canvas.getContext('2d');

const state = {
  // ── View ──
  viewMode:          'iso',
  isoAngle:          0,        // yaw radians, rotation around map centre Z-axis
  isoPitch:          0.5,      // pitch 0=flat/plan-view  1=steep/side-view  default ~30°
  isoZoom:           1.0,      // zoom multiplier for ISO view only (scroll wheel)
  sideAltScale:      1.0,      // vertical stretch for SIDE view height axis
  simEnded:          false,    // true after END SIM pressed
  showFullPaths:     true,     // toggle for full flight path overlay
  showKillsOnly:     false,    // toggle for kills-only path filter in review mode
  showScales:        true,     // toggle for ISO edge + altitude scales
  isoDragging:       false,
  isoDragStartX:     0,
  isoDragStartY:     0,
  isoDragStartAngle: 0,
  isoDragStartPitch: 0,

  // ── World ──
  mapFieldSize: 1000,  // user-configurable square battlefield side length (metres)
  target:       null,

  // ── Entities ──
  launchers:    [],
  drones:       [],
  interceptors: [],
  explosions:   [],
  salvoQueue:   [],
  craters:      [],

  // ── Sim clock ──
  simTime: 0,
  lastTS:  0,
  frameN:  0,

  // ── Run state ──
  running: false,
  paused:  false,
  animId:  null,

  // ── Stats ──
  hitCount:      0,
  killCount:     0,
  totalSpawned:  0,
  spawnQueue:    0,
  spawnTimer:    0,
  closestMiss:   Infinity,
  killTimes:     [],
  maxIntcSpd:    0,
  droneTravelLog:[],
  totalFired:    0,
  firedLog:      [],

  // ── Sweep ──
  sweepAborted: false,
  sweepRunning: false,

  // ── Selection / telemetry ──
  selectedIntcId: null, intcIdCounter: 0, deadInterceptors: [],
};

export default state;
