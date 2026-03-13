// Physics constants, motor definitions, and drone type data used across all modules.

export const PX = 0.5;           // pixels per meter (ISO view base scale)
export const GRAVITY = 9.81;
export const TRAIL_LEN = 90;

export const DRONE_TYPES = {
  // killR: physical strike radius for a CONTACT fuze only — represents the rocket nose
  // physically hitting the drone body. This is NOT a proximity envelope. For proximity
  // kills, enable fragmentation mode and set fragRadius via the slider independently.
  // Values are ~half the largest drone dimension (fuselage/frame), accounting for
  // impact geometry probability across the target planform.
  shahed:     { name:'Shahed-136', spd:42,  turn:8,   maxG:2.5, color:'#ff2233', minTR:300, climbR:3,  killR:0.80 }, // 2.5m wingspan — body/wing strike
  quadcopter: { name:'FPV Quad',   spd:44,  turn:90,  maxG:12,  color:'#ff7700', minTR:5,   climbR:10, killR:0.25 }, // ~0.3m frame
  phantom:    { name:'DJI Phantom',spd:20,  turn:45,  maxG:5,   color:'#ffaa33', minTR:15,  climbR:5,  killR:0.40 }, // ~0.5m frame
};

// ── Motor definitions ──
// avgThr: average (flat) thrust N | peakThr: peak at top of ramp N
// burn: total burn time s | impulse: total impulse N·s | cost: USD
// drag: aerodynamic drag coefficient (coast phase) | propMass: propellant mass g
// maxSpd: realistic terminal velocity (m/s) — used for TOF estimates & soft cap
// Derived from total impulse / average launch mass, capped at reasonable supersonic limits
export const MOTORS = {
  h45w:   { name:'H45W',   avgThr:45,   peakThr:90,   burn:6.0, impulse:270,  cls:'H', drag:0.18, cost:45,  propMass:150,  maxSpd:55  },
  h128w:  { name:'H128W',  avgThr:128,  peakThr:210,  burn:2.0, impulse:256,  cls:'H', drag:0.18, cost:50,  propMass:142,  maxSpd:60  },
  i49w:   { name:'I49W',   avgThr:49,   peakThr:95,   burn:7.7, impulse:377,  cls:'I', drag:0.16, cost:65,  propMass:210,  maxSpd:75  },
  i59w:   { name:'I59W',   avgThr:59,   peakThr:115,  burn:8.0, impulse:472,  cls:'I', drag:0.16, cost:70,  propMass:262,  maxSpd:85  },
  i200w:  { name:'I200W',  avgThr:200,  peakThr:380,  burn:2.5, impulse:500,  cls:'I', drag:0.15, cost:75,  propMass:278,  maxSpd:100 },
  j90w:   { name:'J90W',   avgThr:90,   peakThr:170,  burn:5.0, impulse:450,  cls:'J', drag:0.14, cost:110, propMass:250,  maxSpd:110 },
  j120w:  { name:'J120W',  avgThr:120,  peakThr:230,  burn:4.2, impulse:504,  cls:'J', drag:0.14, cost:115, propMass:280,  maxSpd:120 },
  j330w:  { name:'J330W',  avgThr:330,  peakThr:620,  burn:2.8, impulse:924,  cls:'J', drag:0.13, cost:130, propMass:513,  maxSpd:160 },
  k185w:  { name:'K185W',  avgThr:185,  peakThr:350,  burn:5.0, impulse:925,  cls:'K', drag:0.12, cost:180, propMass:514,  maxSpd:180 },
  k400w:  { name:'K400W',  avgThr:400,  peakThr:780,  burn:3.2, impulse:1280, cls:'K', drag:0.11, cost:200, propMass:711,  maxSpd:220 },
  k1000w: { name:'K1000W', avgThr:1000, peakThr:1800, burn:1.8, impulse:1800, cls:'K', drag:0.10, cost:240, propMass:1000, maxSpd:280 },
};

// ── Fixed airframe mass (grams) — does not change with motor or payload ──
export const FIXED_DRY_MASS_G = 2701; // airframe 1800 + servos 280 + FC 120 + compute 46 + cam 25 + battery 280 + misc 150
export const INTERCEPTOR_AIRFRAME_COST = 420; // USD — fiberglass airframe + avionics + battery

// ── Trapezoid thrust curve helper ──
// Returns instantaneous thrust at elapsed burn time t (0..burnTotal)
export function thrustAtTime(motor, t) {
  const b = motor.burn;
  const ramp = b * 0.10; // 10% ramp up / 10% ramp down
  if (t < 0 || t > b) return 0;
  if (t < ramp)       return motor.avgThr + (motor.peakThr - motor.avgThr) * (t / ramp);
  if (t > b - ramp)   return motor.avgThr + (motor.peakThr - motor.avgThr) * ((b - t) / ramp);
  return motor.avgThr;
}
