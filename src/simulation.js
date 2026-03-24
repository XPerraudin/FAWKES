// Core sim loop, physics tick, spawn logic, and parameter sweep engine.
import { DRONE_TYPES, MOTORS, GRAVITY, TRAIL_LEN, FIXED_DRY_MASS_G, INTERCEPTOR_AIRFRAME_COST, thrustAtTime } from './constants.js';
import state from './state.js';
import { logEvent } from './logger.js';
import { draw } from './renderer.js';
import { steerInterceptor } from './guidance.js';
// NOTE: circular import with ui.js — safe because usage is in function bodies only
import { updateHUD, updatePathsBtn, addInterceptorChip, markChipDead, clearRoster, renderTelemPlots } from './ui.js';

// Maximum physics substep size in seconds
const MAX_SUBSTEP = 0.016;

// ── Agility / mass helpers (read live slider values) ──
export function getAgilityParams() {
  const g = parseFloat(document.getElementById('agilityG').value);
  const t = g / 25.0;
  const cd     = 0.40 + t * (0.62 - 0.40);
  const areaM2 = 0.00333 + t * (0.00520 - 0.00333);
  let addedMassG;
  if (g <= 12) { addedMassG = (g / 12.0) * 120; }
  else         { addedMassG = 120 + ((g - 12) / 13.0) * 160; }
  return { g, cd, areaM2, addedMassG, maxLatG: g };
}

export function getLaunchMassG() {
  const m = MOTORS[document.getElementById('motorType').value];
  const payloadG = parseInt(document.getElementById('payloadMass').value);
  const { addedMassG } = getAgilityParams();
  return FIXED_DRY_MASS_G + addedMassG + m.propMass + payloadG;
}

export function getEffectiveDryMassG() {
  const payloadG = parseInt(document.getElementById('payloadMass').value);
  const { addedMassG } = getAgilityParams();
  return FIXED_DRY_MASS_G + addedMassG + payloadG;
}

export function getEffectiveTurnRate() {
  const payloadG = parseInt(document.getElementById('payloadMass').value);
  const reduction = Math.floor(payloadG / 500) * 8;
  return Math.max(10, 90 - reduction);
}

// ── Main animation loop ──
function loop(ts) {
  if (!state.running || state.paused) return;
  const rawDt   = Math.min((ts - state.lastTS) / 1000, 0.05);
  state.lastTS  = ts;
  const spd     = parseFloat(document.getElementById('simSpeed').value);
  const totalDt = rawDt * spd;

  const nSteps = Math.ceil(totalDt / MAX_SUBSTEP);
  const subDt  = totalDt / nSteps;
  for (let s = 0; s < nSteps; s++) {
    state.simTime += subDt;
    state.frameN++;
    update(subDt);
  }

  draw();
  renderTelemPlots();
  updateHUD();
  state.animId = requestAnimationFrame(loop);
}

// ── Physics update ──
function update(dt) {
  const gravOn = document.getElementById('gravityOn').value === '1';

  // Spawn drones from queue
  if (state.spawnQueue > 0) {
    state.spawnTimer -= dt;
    if (state.spawnTimer <= 0) {
      spawnDrone();
      state.spawnQueue--;
      state.spawnTimer = parseFloat(document.getElementById('spawnInterval').value);
    }
  }

  // ── DRONES ──
  for (const d of state.drones) {
    if (!d.alive) continue;
    d.age += dt;

    const tdx = state.target.x - d.wx, tdy = state.target.y - d.wy;
    const hDist   = Math.sqrt(tdx*tdx + tdy*tdy);
    const desAng  = Math.atan2(tdy, tdx);

    let da = desAng - d.angle;
    while (da >  Math.PI) da -= Math.PI*2;
    while (da < -Math.PI) da += Math.PI*2;
    const maxTurn = (d.type.turn * Math.PI / 180) * dt;
    da = Math.max(-maxTurn, Math.min(maxTurn, da));
    d.angle += da;

    d.vx = Math.cos(d.angle) * d.type.spd;
    d.vy = Math.sin(d.angle) * d.type.spd;

    if (d.phase === 'cruise') {
      const altErr = d.targetAlt - d.wz;
      d.vz = Math.max(-d.type.climbR, Math.min(d.type.climbR, altErr * 1.5));
    } else {
      if (d.type === DRONE_TYPES.shahed) {
        d.vz = Math.max(-20, (4 - d.wz) * 0.5);
      } else if (d.type === DRONE_TYPES.quadcopter) {
        d.vx = Math.cos(d.angle) * d.type.spd * 1.4;
        d.vy = Math.sin(d.angle) * d.type.spd * 1.4;
        d.vz = Math.min(-25, (0 - d.wz) * 2.5);
      } else {
        d.vz *= 0.92;
      }
    }

    if (hDist < 40) d.phase = 'terminal';

    d.wx += d.vx*dt; d.wy += d.vy*dt; d.wz += d.vz*dt;
    d.wz = Math.max(d.phase === 'terminal' ? 2 : 5, d.wz);

    d.trail.push({wx:d.wx, wy:d.wy, wz:d.wz});
    if (d.trail.length > TRAIL_LEN) d.trail.shift();
    if (state.frameN % 3 === 0) d.fullPath.push({wx:d.wx, wy:d.wy, wz:d.wz});

    const dist3 = Math.sqrt(tdx*tdx + tdy*tdy + d.wz*d.wz);
    if (dist3 < d.type.killR * 2) {
      d.alive = false; state.hitCount++;
      state.explosions.push({wx:d.wx, wy:d.wy, wz:d.wz, r:1, maxR:60, alpha:1, color:'#ff2233'});
      logEvent(`⚡ IMPACT! T${d.id} [${d.type.name}]`, 'hit');
    }
    const W = state.mapFieldSize;
    if (d.wx < -200 || d.wx > W+200 || d.wy < -200 || d.wy > W+200) d.alive = false;
  }

  // ── PROCESS SALVO QUEUE ──
  for (let i = state.salvoQueue.length - 1; i >= 0; i--) {
    const s = state.salvoQueue[i];
    if (state.simTime >= s.fireAt) {
      if (s.drone.alive) spawnInterceptor(s.launcher, s.drone, s.offset);
      state.salvoQueue.splice(i, 1);
    }
  }

  // ── AUTO-LAUNCH ──
  const launchRangeM   = parseInt(document.getElementById('launchRange').value);
  const engagementRule = document.getElementById('engagementRule').value;
  const cooldown = 3.5;

  if (engagementRule !== 'hold') {
    const candidates = [];
    for (const d of state.drones) {
      if (!d.alive) continue;
      let closestDist = Infinity;
      for (const l of state.launchers) {
        const dx = d.wx-l.wx, dy = d.wy-l.wy, dz = d.wz-l.wz;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (dist < closestDist) closestDist = dist;
      }
      if (closestDist < launchRangeM) candidates.push({ d, dist: closestDist });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    const targets = engagementRule === 'closest' ? candidates.slice(0, 1) : candidates;

    for (const l of state.launchers) {
      if (state.simTime - l.lastShot < cooldown) continue;
      if (state.salvoQueue.some(s => s.launcher === l)) continue;
      for (const { d } of targets) {
        const dx = d.wx-l.wx, dy = d.wy-l.wy, dz = d.wz-l.wz;
        if (Math.sqrt(dx*dx + dy*dy + dz*dz) < launchRangeM) {
          const alreadyEngaged = state.interceptors.some(i => i.alive && i.target === d);
          if (!alreadyEngaged) {
            queueSalvo(l, d);
            l.lastShot = state.simTime;
            break;
          }
        }
      }
    }
  }

  // ── INTERCEPTORS ──
  for (const intc of state.interceptors) {
    if (!intc.alive) continue;
    intc.age += dt;

    const spd3 = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
    if (spd3 > state.maxIntcSpd) state.maxIntcSpd = spd3;

    const AERO_rho = 1.225;
    const AERO_K   = 0.5 * intc.agilCd * AERO_rho * intc.agilArea;

    let telemThrust = 0, telemDrag = 0;
    if (intc.burnRemaining > 0) {
      const burnElapsed  = intc.burnTotal - intc.burnRemaining;
      const curThrust    = thrustAtTime(intc.motor, burnElapsed);
      intc.currentThrust = curThrust;
      telemThrust = curThrust; telemDrag = AERO_K * spd3 * spd3;

      const propFrac     = intc.burnRemaining / intc.burnTotal;
      intc.currentMassG  = intc.dryMassG + intc.propMassG * propFrac;

      const massKg = intc.currentMassG * 0.001;
      intc.burnRemaining -= dt;
      if (spd3 > 0.1) {
        const ux = intc.vx/spd3, uy = intc.vy/spd3, uz = intc.vz/spd3;
        const dv = (curThrust / massKg) * dt;
        intc.vx += ux*dv; intc.vy += uy*dv; intc.vz += uz*dv;
      } else {
        intc.vz += (curThrust / massKg) * dt;
      }

      if (spd3 > 0.01) {
        const massKgD = intc.currentMassG * 0.001;
        const F_drag  = AERO_K * spd3 * spd3;
        const dragAcc = F_drag / massKgD;
        const da = dragAcc * dt;
        intc.vx -= (intc.vx/spd3) * da;
        intc.vy -= (intc.vy/spd3) * da;
        intc.vz -= (intc.vz/spd3) * da;
      }
    } else {
      if (!intc.burnoutSpd) intc.burnoutSpd = spd3;   // record speed at burnout once
      intc.currentMassG  = intc.dryMassG;
      intc.currentThrust = 0;
      telemDrag = AERO_K * spd3 * spd3;
      const massKg = intc.dryMassG * 0.001;

      if (gravOn) intc.vz -= GRAVITY * dt;

      if (spd3 > 0.01) {
        const F_drag  = AERO_K * spd3 * spd3;
        const dragAcc = F_drag / massKg;
        const da = dragAcc * dt;
        intc.vx -= (intc.vx/spd3) * da;
        intc.vy -= (intc.vy/spd3) * da;
        intc.vz -= (intc.vz/spd3) * da;
      }
    }

    // Mid-flight guidance (delegated to guidance.js)
    const vxPre = intc.vx, vyPre = intc.vy, vzPre = intc.vz;
    steerInterceptor(intc, dt);

    intc.wx += intc.vx*dt; intc.wy += intc.vy*dt; intc.wz += intc.vz*dt;
    if (intc.wz > intc.maxAlt) intc.maxAlt = intc.wz;
    intc.trail.push({wx:intc.wx, wy:intc.wy, wz:intc.wz});
    if (intc.trail.length > TRAIL_LEN) intc.trail.shift();
    if (state.frameN % 3 === 0) intc.fullPath.push({wx:intc.wx, wy:intc.wy, wz:intc.wz});

    const dvx = intc.vx - vxPre, dvy = intc.vy - vyPre, dvz = intc.vz - vzPre;
    const latAccel = Math.sqrt(dvx**2 + dvy**2 + dvz**2) / dt;
    const latG = latAccel / 9.81;
    intc.telem.push({
      t:        state.simTime,
      wx:       intc.wx,
      wy:       intc.wy,
      speed:    Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2),
      accMag:   Math.sqrt(((telemThrust - telemDrag) / (intc.currentMassG * 0.001))**2),
      thrust:   telemThrust,
      drag:     telemDrag,
      altitude: intc.wz,
      latG,
    });
    if (intc.telem.length > 2000) intc.telem.shift();

    // Kill check
    if (intc.target.alive) {
      const kdx = intc.wx - intc.target.wx, kdy = intc.wy - intc.target.wy, kdz = intc.wz - intc.target.wz;
      const kd  = Math.sqrt(kdx*kdx + kdy*kdy + kdz*kdz);
      if (kd < state.closestMiss) state.closestMiss = kd;

      const killDist = intc.fragOn ? Math.max(intc.fragR, intc.target.type.killR) : intc.target.type.killR;
      if (kd < killDist) {
        state.deadInterceptors.push({ ...intc, telem: [...intc.telem] });
        if (state.deadInterceptors.length > 50) state.deadInterceptors.shift();
        intc.alive = false; intc.target.alive = false; state.killCount++;
        markChipDead(intc.id);
        intc.wasKill = true;
        intc.target.wasKilled = true;
        state.killTimes.push(intc.age);
        const exColor = intc.fragOn ? '#ffaa00' : '#00ff88';
        const exMax   = intc.fragOn ? intc.fragR * 4 : 48;
        state.explosions.push({wx:intc.wx, wy:intc.wy, wz:intc.wz, r:1, maxR:exMax, alpha:1,
          color:exColor, fragR: intc.fragOn ? intc.fragR : 0 });
        state.craters.push({wx:intc.wx, wy:intc.wy, wz:intc.wz, id:intc.id, type:'kill'});
        const lp = intc.targetPosAtLaunch;
        const droneTravelKill = Math.sqrt((intc.target.wx-lp.wx)**2 + (intc.target.wy-lp.wy)**2 + (intc.target.wz-lp.wz)**2);
        logEvent(`✓ ${intc.fragOn?'FRAG ':''}KILL! I${intc.id}→T${intc.target.id} @${Math.round(intc.wz)}m Δ${kd.toFixed(1)}m ${intc.age.toFixed(1)}s  ↑${Math.round(intc.maxAlt)}m  drone+${Math.round(droneTravelKill)}m`, 'intercept');
        state.droneTravelLog.push(droneTravelKill);
      }
    }

    // Ground hit
    if (intc.wz <= 0) {
      intc.wz = 0;
      state.deadInterceptors.push({ ...intc, telem: [...intc.telem] });
      if (state.deadInterceptors.length > 50) state.deadInterceptors.shift();
      intc.alive = false;
      markChipDead(intc.id);
      state.explosions.push({wx:intc.wx, wy:intc.wy, wz:0, r:1, maxR:15, alpha:0.6, color:'#886600', fragR:0});
      state.craters.push({wx:intc.wx, wy:intc.wy, wz:0, id:intc.id, type:'crash'});
      const lpC = intc.targetPosAtLaunch;
      const tgt = intc.target;
      const droneTravelCrash = Math.sqrt((tgt.wx-lpC.wx)**2 + (tgt.wy-lpC.wy)**2 + (tgt.wz-lpC.wz)**2);
      logEvent(`✗ CRASH I${intc.id} — hit ground @(${Math.round(intc.wx)}m,${Math.round(intc.wy)}m)  ↑${Math.round(intc.maxAlt)}m  drone+${Math.round(droneTravelCrash)}m`, 'hit');
      state.droneTravelLog.push(droneTravelCrash);
    }
    const W = state.mapFieldSize;
    if (intc.wx < -400 || intc.wx > W+400 || intc.wy < -400 || intc.wy > W+400 || intc.wz > 3000) {
      state.deadInterceptors.push({ ...intc, telem: [...intc.telem] });
      if (state.deadInterceptors.length > 50) state.deadInterceptors.shift();
      intc.alive = false;
      markChipDead(intc.id);
    }
  }

  // Explosions decay
  for (let i = state.explosions.length - 1; i >= 0; i--) {
    const ex = state.explosions[i];
    ex.r += (ex.maxR - ex.r) * 0.11; ex.alpha -= 0.022;
    if (ex.alpha <= 0) state.explosions.splice(i, 1);
  }

  // Auto-end when all threats neutralised
  if (state.running && !state.paused && state.spawnQueue === 0 && state.totalSpawned > 0 && state.drones.every(d => !d.alive)) {
    state.paused = true;
    logEvent('── All threats eliminated — engagement complete ──', 'intercept');
  }
}

// ── Spawn a drone ──
function spawnDrone() {
  const typeKey = document.getElementById('droneType').value;
  const W = state.mapFieldSize;
  const edge = Math.floor(Math.random() * 4);
  let wx, wy;
  const mg = Math.max(50, W * 0.05);
  if      (edge === 0) { wx = Math.random()*W; wy = mg; }
  else if (edge === 1) { wx = W-mg; wy = Math.random()*W; }
  else if (edge === 2) { wx = Math.random()*W; wy = W-mg; }
  else                 { wx = mg; wy = Math.random()*W; }

  let tk;
  if (typeKey === 'swarm') {
    const keys = ['shahed','quadcopter','phantom'];
    tk = DRONE_TYPES[keys[Math.floor(Math.random()*3)]];
  } else {
    tk = DRONE_TYPES[typeKey];
  }

  const baseAlt  = parseInt(document.getElementById('droneAlt').value);
  const variance = parseInt(document.getElementById('altVar').value);
  const wz       = Math.max(15, baseAlt + (Math.random()-0.5)*2*variance);

  const tdx = state.target.x - wx, tdy = state.target.y - wy;
  const ang = Math.atan2(tdy, tdx);

  state.drones.push({
    wx, wy, wz,
    targetAlt: wz,
    vx: Math.cos(ang)*tk.spd, vy: Math.sin(ang)*tk.spd, vz: 0,
    angle: ang, type: tk, alive: true, trail: [], fullPath: [],
    id: state.totalSpawned++, phase: 'cruise', age: 0,
  });
  logEvent(`Threat ${state.totalSpawned-1} [${tk.name}] alt=${Math.round(wz)}m`, 'launch');
}

// ── Spawn an interceptor ──
function spawnInterceptor(launcher, td, bearingOffsetRad = 0) {
  const mKey        = document.getElementById('motorType').value;
  const motor       = MOTORS[mKey];
  const seekMode    = document.getElementById('seekMode').value;
  const trajectMode = document.getElementById('trajectMode').value;
  const loftAddDeg  = parseInt(document.getElementById('loftAngle').value);
  const elevDeg     = parseInt(document.getElementById('launchElev').value);
  const elevRad     = elevDeg * Math.PI / 180;
  const fragOn      = document.getElementById('fragEnabled').checked;
  const fragR       = parseInt(document.getElementById('fragRadius').value);

  // Aim point at launch
  let aimX = td.wx, aimY = td.wy, aimZ = td.wz;
  if (seekMode === 'lead') {
    const dx = td.wx - launcher.wx, dy = td.wy - launcher.wy, dz = td.wz - launcher.wz;
    const d3  = Math.sqrt(dx*dx + dy*dy + dz*dz);
    const tof = d3 / (motor.maxSpd * 0.65);
    aimX = td.wx + td.vx * tof * 0.55;
    aimY = td.wy + td.vy * tof * 0.55;
    aimZ = Math.max(10, td.wz + td.vz * tof * 0.55);
  }

  const ddx = aimX - launcher.wx, ddy = aimY - launcher.wy, ddz = aimZ - launcher.wz;
  const hDist    = Math.sqrt(ddx*ddx + ddy*ddy);
  const hBearing = Math.atan2(ddy, ddx) + bearingOffsetRad;

  let lElev = seekMode === 'ballistic'
    ? elevRad
    : Math.max(10 * Math.PI/180, Math.atan2(ddz, hDist));

  if (trajectMode === 'lofted') {
    lElev = Math.min(Math.PI * 0.48, lElev + loftAddDeg * Math.PI/180);
  }

  const payloadG    = parseInt(document.getElementById('payloadMass').value);
  const { cd: agilCd, areaM2: agilArea, addedMassG, maxLatG } = getAgilityParams();
  const launchMassG = FIXED_DRY_MASS_G + addedMassG + motor.propMass + payloadG;
  const dryMassG    = FIXED_DRY_MASS_G + addedMassG + payloadG;
  const effectiveTurnRate = getEffectiveTurnRate();

  const initThrust = thrustAtTime(motor, 0);
  const initAcc    = initThrust / (launchMassG * 0.001);
  const initSpd    = Math.max(2.0, Math.sqrt(2 * initAcc * 0.5));

  const intcObj = {
    wx: launcher.wx, wy: launcher.wy, wz: launcher.wz + 1,
    vx: Math.cos(hBearing) * Math.cos(lElev) * initSpd,
    vy: Math.sin(hBearing) * Math.cos(lElev) * initSpd,
    vz: Math.sin(lElev) * initSpd,
    motor, seekMode,
    target: td,
    alive: true, trail: [], fullPath: [], telem: [],
    burnRemaining: motor.burn,
    burnTotal:     motor.burn,
    launchMassG, dryMassG, propMassG: motor.propMass,
    effectiveTurnRate,
    age: 0, id: 'IC-' + String(++state.intcIdCounter).padStart(2, '0'),
    trajectMode, fragOn, fragR,
    aimX, aimY, aimZ,
    currentMassG:    launchMassG,
    currentThrust:   initThrust,
    maxAlt:          launcher.wz + 1,
    agilCd, agilArea,
    maxLatG,
    targetPosAtLaunch: { wx: td.wx, wy: td.wy, wz: td.wz },
    terminalPhase: false,
  };
  state.interceptors.push(intcObj);
  addInterceptorChip(intcObj.id);
  launcher.lastShot = state.simTime;
  state.totalFired++;
  state.firedLog.push({ motorKey: mKey, motorCost: motor.cost });
  logEvent(`I${intcObj.id} [${motor.name}|${seekMode}|${trajectMode}${fragOn?'|FRAG':''}] → T${td.id} @${Math.round(td.wz)}m  ${launchMassG}g`, 'launch');
}

// ── Queue a staggered salvo ──
function queueSalvo(launcher, td) {
  const salvoSz   = parseInt(document.getElementById('salvoSize').value);
  const stagger   = parseFloat(document.getElementById('staggerInt').value);
  const spreadDeg = parseInt(document.getElementById('batchSpread').value);
  const spreadRad = spreadDeg * Math.PI / 180;

  for (let b = 0; b < salvoSz; b++) {
    const offset = salvoSz === 1 ? 0 : (b/(salvoSz-1) - 0.5) * spreadRad * 2;
    const fireAt = state.simTime + b * stagger;
    state.salvoQueue.push({ launcher, drone: td, offset, fireAt });
  }
  if (salvoSz > 1) logEvent(`Salvo ×${salvoSz} queued → T${td.id} (Δ${stagger.toFixed(1)}s)`, 'launch');
}

// ════════════════════════════════════
//  BUTTON ACTIONS
// ════════════════════════════════════

export function startSim() {
  if (state.running || state.paused) {
    if (state.animId) cancelAnimationFrame(state.animId);
    state.drones = []; state.interceptors = []; state.explosions = []; state.salvoQueue = []; state.craters = [];
    state.simTime = 0; state.frameN = 0; state.hitCount = 0; state.killCount = 0; state.totalSpawned = 0;
    state.closestMiss = Infinity; state.killTimes = []; state.maxIntcSpd = 0; state.spawnQueue = 0;
    state.totalFired = 0; state.firedLog = []; state.droneTravelLog = [];
    state.simEnded = false; state.showFullPaths = true; state.showKillsOnly = false;
    updatePathsBtn();
    for (const l of state.launchers) l.lastShot = -999;
    logEvent('↺ Scenario restarted', 'info');
  } else {
    logEvent('Simulation started', 'info');
  }

  if (!state.launchers.length) {
    state.launchers.push({ wx: state.target.x, wy: state.target.y, wz: 0, lastShot: -999 });
    logEvent('Auto-launcher placed at target', 'info');
  }

  state.running = true; state.paused = false;
  state.spawnQueue = parseInt(document.getElementById('spawnCount').value);
  state.spawnTimer = 0;
  state.lastTS = performance.now();
  state.animId = requestAnimationFrame(loop);
}

export function pauseSim() {
  if (!state.running) return;
  state.paused = !state.paused;
  if (!state.paused) { state.lastTS = performance.now(); state.animId = requestAnimationFrame(loop); }
  logEvent(state.paused ? 'PAUSED' : 'RESUMED', 'info');
}

export function resetSim() {
  state.running = false; state.paused = false;
  if (state.animId) cancelAnimationFrame(state.animId);
  state.drones = []; state.interceptors = []; state.explosions = []; state.launchers = []; state.craters = [];
  state.simTime = 0; state.frameN = 0; state.hitCount = 0; state.killCount = 0; state.totalSpawned = 0;
  state.closestMiss = Infinity; state.killTimes = []; state.maxIntcSpd = 0; state.spawnQueue = 0; state.salvoQueue = [];
  state.totalFired = 0; state.firedLog = []; state.droneTravelLog = [];
  state.simEnded = false; state.showFullPaths = true; state.showKillsOnly = false;
  clearRoster();
  updatePathsBtn();
  updateHUD();
  draw();
  logEvent('Reset', 'info');
}

export function endSim() {
  if (!state.running && state.totalFired === 0) return;
  if (state.running && !state.paused) { state.paused = true; }

  state.simEnded = true;
  state.showFullPaths = true;
  updatePathsBtn();
  draw();

  // Cost breakdown
  const motorTotals = {};
  let totalMotorCost = 0;
  for (const f of state.firedLog) {
    if (!motorTotals[f.motorKey]) motorTotals[f.motorKey] = { name: MOTORS[f.motorKey].name, count: 0, unitCost: f.motorCost };
    motorTotals[f.motorKey].count++;
    totalMotorCost += f.motorCost;
  }
  const totalAirframeCost = state.totalFired * INTERCEPTOR_AIRFRAME_COST;
  const totalCost = totalMotorCost + totalAirframeCost;
  const unitCost  = state.totalFired > 0 ? totalCost / state.totalFired : 0;

  const escapedAlive = state.drones.filter(d => d.alive).length;
  const tot      = state.hitCount + state.killCount + escapedAlive;
  const killPct  = tot > 0 ? Math.round(state.killCount / tot * 100) : 0;
  const avgKillTime = state.killTimes.length ? (state.killTimes.reduce((a,b)=>a+b,0)/state.killTimes.length).toFixed(1) : '—';

  const peakAlts   = state.interceptors.map(i => i.maxAlt).filter(a => isFinite(a) && a > 0);
  const avgPeakAlt = peakAlts.length ? (peakAlts.reduce((a,b)=>a+b,0) / peakAlts.length).toFixed(0) : '—';
  const maxPeakAlt = peakAlts.length ? Math.round(Math.max(...peakAlts)) : '—';

  const avgDroneTravel = state.droneTravelLog.length
    ? (state.droneTravelLog.reduce((a,b)=>a+b,0) / state.droneTravelLog.length).toFixed(0)
    : '—';

  const row = (label, val, col='#77ffaa') =>
    `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #0d1e12;">
       <span style="color:#2a6645">${label}</span>
       <span style="color:${col};font-weight:bold">${val}</span>
     </div>`;

  const section = (title) =>
    `<div style="font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:3px;color:#00eeff;margin:14px 0 6px;">${title}</div>`;

  let motorRows = '';
  for (const k of Object.keys(motorTotals)) {
    const m = motorTotals[k];
    motorRows += row(`${m.name} ×${m.count}  ($${m.unitCost}/motor)`, `$${(m.count * m.unitCost).toLocaleString()}`);
  }

  const costPerKill = state.killCount > 0 ? totalCost / state.killCount : null;

  const html = `
    ${section('▸ ENGAGEMENT STATISTICS')}
    ${row('Duration', ((state.simTime/60)|0)+'m '+((state.simTime%60).toFixed(1))+'s')}
    ${row('Threats spawned', state.totalSpawned)}
    ${row('Threats neutralised (kills)', state.killCount, '#00ff88')}
    ${row('Threats impacted target', state.hitCount, '#ff2233')}
    ${escapedAlive > 0 ? row('Threats still airborne (escaped)', escapedAlive, '#ffcc00') : ''}
    ${row('Kill rate', killPct + '%' + (escapedAlive > 0 ? ' (incl. escapes)' : ''), killPct >= 70 ? '#00ff88' : killPct >= 40 ? '#ffcc00' : '#ff2233')}
    ${row('Avg kill time', avgKillTime + 's')}
    ${row('Closest miss', state.closestMiss < Infinity ? state.closestMiss.toFixed(1)+'m' : '—')}
    ${row('Avg drone travel during engagement', avgDroneTravel !== '—' ? avgDroneTravel + 'm' : '—', '#ffcc00')}

    ${section('▸ INTERCEPTOR EXPENDITURE')}
    ${row('Total interceptors fired', state.totalFired)}
    ${row('Interceptors per kill', state.killCount > 0 ? (state.totalFired/state.killCount).toFixed(1) : '—')}
    ${row('Ground crashes', state.craters.filter(c=>c.type==='crash').length, '#cc5500')}
    ${row('Avg peak interceptor alt', avgPeakAlt !== '—' ? avgPeakAlt + 'm' : '—', '#00eeff')}
    ${row('Max peak interceptor alt', maxPeakAlt !== '—' ? maxPeakAlt + 'm' : '—', '#00eeff')}

    ${section('▸ COST BREAKDOWN')}
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1e5535;">
      <span style="color:#77ffaa;font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:2px;">COST PER INTERCEPTOR</span>
      <span style="color:#00eeff;font-size:14px;font-weight:bold">$${Math.round(unitCost).toLocaleString()}</span>
    </div>
    <div style="padding:4px 0 8px;border-bottom:1px solid #0d1e12;">
      ${row('Airframe / guidance (×' + state.totalFired + ' @ $' + INTERCEPTOR_AIRFRAME_COST + ')', '$' + totalAirframeCost.toLocaleString())}
      ${motorRows}
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #1e5535;margin-top:4px;">
      <span style="color:#77ffaa;font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:2px;">KILLS</span>
      <span style="color:#00ff88;font-size:14px;font-weight:bold">${state.killCount}</span>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #1e5535;margin-top:4px;">
      <span style="color:#ffcc00;font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:2px;">COST PER KILL</span>
      <span style="color:#ffcc00;font-size:14px;font-weight:bold">${costPerKill !== null ? '$' + Math.round(costPerKill).toLocaleString() : '—'}</span>
    </div>
    <div style="font-size:8px;color:#2a5235;margin-top:6px;line-height:1.6">
      = $${totalCost.toLocaleString()} total ÷ ${state.killCount} kill${state.killCount !== 1 ? 's' : ''}<br>
      * Contact kills require direct strike within drone body radius (Shahed 0.8m / Phantom 0.4m / FPV 0.25m). Enable fragmentation for proximity kill envelope.<br>
      * Full flight paths shown on canvas as dashed overlays.
    </div>
  `;

  document.getElementById('endBody').innerHTML = html;
  const modal = document.getElementById('endModal');
  modal.style.display = 'flex';
}

export function closeEndModal() {
  document.getElementById('endModal').style.display = 'none';
}

// ════════════════════════════════════
//  PARAMETER SWEEP LABORATORY
// ════════════════════════════════════

export function openSweepModal() {
  if (state.running && !state.paused) pauseSim();
  document.getElementById('sweepModal').style.display = 'flex';
  // Defer to ui.js updateSweepCounter — called via import in ui.js setup
  // (ui.js wires the counter update itself on modal open)
}

export function closeSweepModal() {
  state.sweepAborted = true;
  document.getElementById('sweepModal').style.display = 'none';
}

export function sweepGetChecked(group) {
  return [...document.querySelectorAll(`input[data-group="${group}"]:checked`)].map(cb => cb.value);
}

// ── Seeded PRNG (mulberry32) ──
function makePRNG(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Headless single-combination simulation ──
function runHeadlessCombination(params, droneCount, seed) {
  const rng = makePRNG(seed);
  const { droneType, droneAlt, motorKey, loftAngle, launchRange,
          seekMode, fragOn, fragR, maxLatG, salvoSize,
          trajectMode, payloadMass, staggerInterval, batchSpread } = params;

  const motor = MOTORS[motorKey];
  if (!motor) return null;

  const WORLD_SIZE = 1000;
  const tgt      = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
  const launcher = { wx: tgt.x, wy: tgt.y, wz: 0, lastShot: -999 };

  let hDrones = [], hIntcs = [], hSalvoQ = [];
  let hKills = 0, hMisses = 0, hCrashes = 0;
  let hKillTimes = [];
  let hTotalFired = 0;
  let hSimTime = 0;
  let hTotalSpawned = 0;

  const agilT = maxLatG / 25.0;
  const agilCd      = 0.40 + agilT * (0.62 - 0.40);
  const agilArea    = 0.00333 + agilT * (0.00520 - 0.00333);
  const agilAddedMass = maxLatG <= 12
    ? (maxLatG / 12.0) * 120
    : 120 + ((maxLatG - 12) / 13.0) * 160;
  const payloadMassG = (typeof payloadMass === 'number') ? payloadMass : 0;

  const spawnHDrone = () => {
    const edge = Math.floor(rng() * 4);
    const mg = 100;
    let wx, wy;
    if      (edge === 0) { wx = rng() * WORLD_SIZE; wy = mg; }
    else if (edge === 1) { wx = WORLD_SIZE - mg; wy = rng() * WORLD_SIZE; }
    else if (edge === 2) { wx = rng() * WORLD_SIZE; wy = WORLD_SIZE - mg; }
    else                 { wx = mg; wy = rng() * WORLD_SIZE; }

    let tk;
    if (droneType === 'mixed') {
      const keys = ['shahed','quadcopter','phantom'];
      tk = DRONE_TYPES[keys[Math.floor(rng() * 3)]];
    } else {
      tk = DRONE_TYPES[droneType];
    }

    const wz  = Math.max(15, droneAlt + (rng() - 0.5) * 20);
    const ang = Math.atan2(tgt.y - wy, tgt.x - wx);
    hDrones.push({
      wx, wy, wz, targetAlt: wz,
      vx: Math.cos(ang)*tk.spd, vy: Math.sin(ang)*tk.spd, vz: 0,
      angle: ang, type: tk, alive: true, phase: 'cruise', age: 0, id: hTotalSpawned++,
    });
  };

  const spawnHIntc = (td, bearingOffset) => {
    bearingOffset = bearingOffset || 0;
    const ddx = td.wx - launcher.wx, ddy = td.wy - launcher.wy, ddz = td.wz - launcher.wz;
    const hDistH = Math.sqrt(ddx*ddx + ddy*ddy);

    let aimX = td.wx, aimY = td.wy, aimZ = td.wz;
    if (seekMode === 'lead' || seekMode === 'lead_terminal') {
      const d3  = Math.sqrt(ddx*ddx + ddy*ddy + ddz*ddz);
      const tof = d3 / (motor.maxSpd * 0.65);
      aimX = td.wx + td.vx * tof * 0.55;
      aimY = td.wy + td.vy * tof * 0.55;
      aimZ = Math.max(10, td.wz + td.vz * tof * 0.55);
    }

    const adx = aimX - launcher.wx, ady = aimY - launcher.wy, adz = aimZ - launcher.wz;
    const ahDist  = Math.sqrt(adx*adx + ady*ady);
    const hBearing = Math.atan2(ady, adx) + bearingOffset;

    let lElev = seekMode === 'ballistic'
      ? 65 * Math.PI / 180
      : Math.max(10 * Math.PI / 180, Math.atan2(adz, ahDist));

    if (trajectMode === 'lofted' && loftAngle > 0) {
      lElev = Math.min(Math.PI * 0.48, lElev + loftAngle * Math.PI / 180);
    }

    const launchMassG = FIXED_DRY_MASS_G + agilAddedMass + payloadMassG + motor.propMass;
    const dryMassG    = FIXED_DRY_MASS_G + agilAddedMass + payloadMassG;
    const initThrust  = thrustAtTime(motor, 0);
    const initAcc     = initThrust / (launchMassG * 0.001);
    const initSpd     = Math.max(2.0, Math.sqrt(2 * initAcc * 0.5));

    hIntcs.push({
      wx: launcher.wx, wy: launcher.wy, wz: launcher.wz + 1,
      vx: Math.cos(hBearing)*Math.cos(lElev)*initSpd,
      vy: Math.sin(hBearing)*Math.cos(lElev)*initSpd,
      vz: Math.sin(lElev)*initSpd,
      motor, seekMode, target: td, alive: true,
      burnRemaining: motor.burn, burnTotal: motor.burn,
      launchMassG, dryMassG, propMassG: motor.propMass,
      effectiveTurnRate: 90, age: 0,
      trajectMode: trajectMode || (loftAngle > 0 ? 'lofted' : 'direct'),
      fragOn, fragR, aimX, aimY, aimZ,
      currentMassG: launchMassG, maxAlt: 1, agilCd, agilArea, maxLatG,
      terminalPhase: false,
    });
    launcher.lastShot = hSimTime;
    hTotalFired++;
  };

  const queueHSalvo = (td) => {
    const spreadRad = (typeof batchSpread === 'number') ? batchSpread * Math.PI / 180 : 0;
    const stagger   = (typeof staggerInterval === 'number') ? staggerInterval : 0;
    for (let b = 0; b < salvoSize; b++) {
      const offset = salvoSize === 1 ? 0 : (b / (salvoSize - 1) - 0.5) * spreadRad;
      hSalvoQ.push({ drone: td, offset, fireAt: hSimTime + b * stagger });
    }
  };

  const DT = 0.016;
  const MAX_SIM_TIME = 120;
  const COOLDOWN = 3.5;

  let spawnQueue   = droneCount;
  let spawnTimer   = 0;
  const spawnInterval = 3.0;

  while (hSimTime < MAX_SIM_TIME) {
    hSimTime += DT;

    if (spawnQueue > 0) {
      spawnTimer -= DT;
      if (spawnTimer <= 0) { spawnHDrone(); spawnQueue--; spawnTimer = spawnInterval; }
    }

    for (const d of hDrones) {
      if (!d.alive) continue;
      d.age += DT;
      const tdx = tgt.x - d.wx, tdy = tgt.y - d.wy;
      const hDistD = Math.sqrt(tdx*tdx + tdy*tdy);
      const desAng = Math.atan2(tdy, tdx);
      let da = desAng - d.angle;
      while (da >  Math.PI) da -= Math.PI*2;
      while (da < -Math.PI) da += Math.PI*2;
      const maxTurn = (d.type.turn * Math.PI / 180) * DT;
      da = Math.max(-maxTurn, Math.min(maxTurn, da));
      d.angle += da;
      d.vx = Math.cos(d.angle)*d.type.spd;
      d.vy = Math.sin(d.angle)*d.type.spd;
      if (d.phase === 'cruise') {
        const altErr = d.targetAlt - d.wz;
        d.vz = Math.max(-d.type.climbR, Math.min(d.type.climbR, altErr*1.5));
      } else {
        if (d.type === DRONE_TYPES.shahed) {
          d.vz = Math.max(-20, (4 - d.wz)*0.5);
        } else if (d.type === DRONE_TYPES.quadcopter) {
          d.vx = Math.cos(d.angle)*d.type.spd*1.4;
          d.vy = Math.sin(d.angle)*d.type.spd*1.4;
          d.vz = Math.min(-25, (0 - d.wz)*2.5);
        } else { d.vz *= 0.92; }
      }
      if (hDistD < 40) d.phase = 'terminal';
      d.wx += d.vx*DT; d.wy += d.vy*DT; d.wz += d.vz*DT;
      d.wz = Math.max(d.phase === 'terminal' ? 2 : 5, d.wz);
      const dist3 = Math.sqrt(tdx*tdx + tdy*tdy + d.wz*d.wz);
      if (dist3 < d.type.killR * 2) { d.alive = false; hMisses++; }
    }

    for (let i = hSalvoQ.length - 1; i >= 0; i--) {
      const s = hSalvoQ[i];
      if (hSimTime >= s.fireAt) {
        if (s.drone.alive) spawnHIntc(s.drone, s.offset);
        hSalvoQ.splice(i, 1);
      }
    }

    if (hSimTime - launcher.lastShot >= COOLDOWN) {
      const aliveDrones = hDrones.filter(d => d.alive);
      for (const d of aliveDrones) {
        const dx = d.wx - launcher.wx, dy = d.wy - launcher.wy, dz = d.wz - launcher.wz;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (dist < launchRange) {
          const alreadyEngaged = hIntcs.some(i => i.alive && i.target === d);
          if (!alreadyEngaged) { queueHSalvo(d); launcher.lastShot = hSimTime; break; }
        }
      }
    }

    for (const intc of hIntcs) {
      if (!intc.alive) continue;
      intc.age += DT;
      const spd3 = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
      const AERO_K = 0.5 * intc.agilCd * 1.225 * intc.agilArea;

      if (intc.burnRemaining > 0) {
        const burnElapsed = intc.burnTotal - intc.burnRemaining;
        const curThrust = thrustAtTime(intc.motor, burnElapsed);
        const propFrac  = intc.burnRemaining / intc.burnTotal;
        intc.currentMassG = intc.dryMassG + intc.propMassG * propFrac;
        const massKg = intc.currentMassG * 0.001;
        intc.burnRemaining -= DT;
        if (spd3 > 0.1) {
          const dv = (curThrust / massKg) * DT;
          intc.vx += (intc.vx/spd3)*dv; intc.vy += (intc.vy/spd3)*dv; intc.vz += (intc.vz/spd3)*dv;
        } else { intc.vz += (curThrust / massKg) * DT; }
        if (spd3 > 0.01) {
          const da2 = (AERO_K * spd3 * spd3 / (intc.currentMassG * 0.001)) * DT;
          intc.vx -= (intc.vx/spd3)*da2; intc.vy -= (intc.vy/spd3)*da2; intc.vz -= (intc.vz/spd3)*da2;
        }
      } else {
        if (!intc.burnoutSpd) intc.burnoutSpd = spd3;   // record speed at burnout once
        intc.currentMassG = intc.dryMassG;
        intc.vz -= 9.81 * DT;
        if (spd3 > 0.01) {
          const da2 = (AERO_K * spd3 * spd3 / (intc.dryMassG * 0.001)) * DT;
          intc.vx -= (intc.vx/spd3)*da2; intc.vy -= (intc.vy/spd3)*da2; intc.vz -= (intc.vz/spd3)*da2;
        }
      }

      // Headless steering
      if (intc.maxLatG > 0 && intc.seekMode !== 'ballistic' && intc.target.alive) {
        if (intc.seekMode === 'lead_terminal' && !intc.terminalPhase) {
          const ttdx = intc.target.wx - intc.wx, ttdy = intc.target.wy - intc.wy, ttdz = intc.target.wz - intc.wz;
          if (Math.sqrt(ttdx*ttdx + ttdy*ttdy + ttdz*ttdz) <= 35) intc.terminalPhase = true;
        }
        let stX, stY, stZ;
        if (intc.seekMode === 'lead_terminal' && intc.terminalPhase) {
          stX = intc.target.wx; stY = intc.target.wy; stZ = intc.target.wz;
        } else if (intc.trajectMode === 'lofted' && intc.vz > 0) {
          stX = intc.aimX; stY = intc.aimY; stZ = intc.aimZ;
        } else {
          stX = intc.target.wx; stY = intc.target.wy; stZ = intc.target.wz;
        }
        const tdx2 = stX-intc.wx, tdy2 = stY-intc.wy, tdz2 = stZ-intc.wz;
        const td3 = Math.sqrt(tdx2*tdx2 + tdy2*tdy2 + tdz2*tdz2);
        const cs  = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
        if (td3 > 0.1 && cs > 0.1) {
          // Dynamic-pressure scaling: unconditional, same logic as guidance.js
          let effectiveLatG2 = intc.maxLatG;
          const refSpd2 = intc.burnoutSpd ?? cs; // fallback during burn phase
          if (refSpd2 > 0) {
            const spdRatio2  = cs / refSpd2;
            effectiveLatG2   = intc.maxLatG * spdRatio2 * spdRatio2;
            effectiveLatG2   = Math.max(0.5, Math.min(intc.maxLatG, effectiveLatG2));
          }
          const maxLatAccel = effectiveLatG2 * 9.81; // m/s²
          const dvx = (tdx2/td3)*cs - intc.vx, dvy = (tdy2/td3)*cs - intc.vy, dvz = (tdz2/td3)*cs - intc.vz;
          const ux = intc.vx/cs, uy = intc.vy/cs, uz = intc.vz/cs;
          const parDot = dvx*ux + dvy*uy + dvz*uz;
          const px = dvx-parDot*ux, py = dvy-parDot*uy, pz = dvz-parDot*uz;
          const pm = Math.sqrt(px*px + py*py + pz*pz);
          const maxPdv = maxLatAccel * DT;
          const sc = pm > maxPdv ? maxPdv/pm : 1.0;
          intc.vx += px*sc; intc.vy += py*sc; intc.vz += pz*sc;
          const ns = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
          if (ns > 0.1) { const f = cs/ns; intc.vx *= f; intc.vy *= f; intc.vz *= f; }
        }
      }

      if (intc.target.alive) {
        const kdx = intc.wx - intc.target.wx, kdy = intc.wy - intc.target.wy, kdz = intc.wz - intc.target.wz;
        const kd = Math.sqrt(kdx*kdx + kdy*kdy + kdz*kdz);
        const killDist = fragOn ? Math.max(fragR, intc.target.type.killR) : intc.target.type.killR;
        if (kd < killDist) {
          intc.alive = false; intc.target.alive = false;
          hKills++; hKillTimes.push(intc.age);
        }
      }
      if (intc.wz <= 0) { intc.wz = 0; intc.alive = false; hCrashes++; }
      intc.wx += intc.vx*DT; intc.wy += intc.vy*DT; intc.wz += intc.vz*DT;
      if (intc.wz > intc.maxAlt) intc.maxAlt = intc.wz;
    }

    const allDead = spawnQueue === 0 && hTotalSpawned > 0 && hDrones.every(d => !d.alive) && hIntcs.every(i => !i.alive || hSalvoQ.length === 0);
    if (allDead && hSimTime > 2) break;
  }

  const total = hKills + hMisses;
  const avgKT = hKillTimes.length ? hKillTimes.reduce((a,b)=>a+b,0)/hKillTimes.length : null;
  return { kills: hKills, misses: hMisses, total, killRate: total > 0 ? hKills / total : 0, avgKillTime: avgKT, fired: hTotalFired, crashes: hCrashes };
}

export function startSweep() {
  const droneTypes   = sweepGetChecked('drone');
  const motors       = sweepGetChecked('motor');
  const lofts        = sweepGetChecked('loft').map(Number);
  const ranges       = sweepGetChecked('range').map(Number);
  const agilities    = sweepGetChecked('agility').map(Number);
  const fragRs       = sweepGetChecked('fragr').map(Number);
  const seekModes    = sweepGetChecked('seekmode');
  const trajModes    = sweepGetChecked('trajmode');
  const payloads     = sweepGetChecked('payload').map(Number);
  const salvos       = sweepGetChecked('salvo').map(Number);
  const staggers     = sweepGetChecked('stagger').map(Number);
  const batchSpreads = sweepGetChecked('batchspread').map(Number);
  const fragOns      = sweepGetChecked('fragon').map(v => v === 'true');
  const droneCount   = parseInt(document.getElementById('swDroneCount').value) || 10;

  if (!droneTypes.length || !motors.length || !lofts.length || !ranges.length
   || !agilities.length || !fragRs.length || !seekModes.length || !trajModes.length
   || !payloads.length || !salvos.length || !staggers.length || !batchSpreads.length || !fragOns.length) {
    alert('Select at least one option in every parameter group.'); return;
  }

  const combos = [];
  const DRONE_ALTS = { shahed: 120, quadcopter: 80, phantom: 100, mixed: 110 };
  for (const droneType of droneTypes)
  for (const motorKey of motors)
  for (const loftAngle of lofts)
  for (const launchRange of ranges)
  for (const maxLatG of agilities)
  for (const fragR of fragRs)
  for (const seekMode of seekModes)
  for (const trajectMode of trajModes)
  for (const payloadMass of payloads)
  for (const salvoSize of salvos)
  for (const staggerInterval of staggers)
  for (const batchSpread of batchSpreads)
  for (const fragOn of fragOns)
    combos.push({ droneType, droneAlt: DRONE_ALTS[droneType], motorKey, loftAngle, launchRange,
                  maxLatG, fragR, seekMode, trajectMode, payloadMass, salvoSize,
                  staggerInterval, batchSpread, fragOn });

  state.sweepAborted = false;
  state.sweepRunning = true;
  const allResults = [];
  let liveKills = 0, liveMisses = 0;

  document.getElementById('swRunBtn').style.display = 'none';
  document.getElementById('swAbortBtn').style.display = 'inline-block';
  document.getElementById('swProgressWrap').style.display = 'block';
  document.getElementById('swResultsSection').style.display = 'none';

  const startWall = performance.now();

  const runNext = (idx) => {
    if (state.sweepAborted || idx >= combos.length) {
      finishSweep(allResults, state.sweepAborted); return;
    }

    const pct = idx / combos.length * 100;
    document.getElementById('swProgressBar').style.width = pct + '%';
    document.getElementById('swProgressLabel').textContent = `Combination ${idx+1} of ${combos.length}`;

    const elapsed = (performance.now() - startWall) / 1000;
    if (idx > 0) {
      const rate = elapsed / idx;
      const remaining = rate * (combos.length - idx);
      const mins = Math.floor(remaining / 60), secs = Math.round(remaining % 60);
      document.getElementById('swETA').textContent = `ETA: ${mins > 0 ? mins+'m ' : ''}${secs}s`;
    }

    const combo  = combos[idx];
    const seed   = idx * 2654435761 ^ 0xdeadbeef;
    const result = runHeadlessCombination(combo, droneCount, seed);

    if (result) {
      liveKills  += result.kills;
      liveMisses += result.misses;
      document.getElementById('swLiveKills').textContent  = liveKills;
      document.getElementById('swLiveMisses').textContent = liveMisses;
      const liveTotal = liveKills + liveMisses;
      document.getElementById('swLiveRate').textContent = liveTotal > 0
        ? Math.round(liveKills / liveTotal * 100) + '%' : '—';
      allResults.push({ params: combo, result });
    }

    setTimeout(() => runNext(idx + 1), 0);
  };

  runNext(0);
}

export function abortSweep() {
  state.sweepAborted = true;
}

export function finishSweep(results, aborted) {
  state.sweepRunning = false;
  document.getElementById('swRunBtn').style.display = 'inline-block';
  document.getElementById('swAbortBtn').style.display = 'none';
  document.getElementById('swProgressBar').style.width = '100%';
  document.getElementById('swProgressBar').style.background = aborted ? '#ff2233' : '#00ff88';
  document.getElementById('swETA').textContent = aborted ? 'ABORTED' : 'COMPLETE';

  if (!results.length) return;

  results.sort((a, b) => b.result.killRate - a.result.killRate);

  const top5 = results.slice(0, 5);
  let tableHtml = `<table style="width:100%;border-collapse:collapse;font-size:8px;">
    <tr style="color:#00eeff;border-bottom:1px solid #1a3a1a;">
      <th style="text-align:left;padding:3px 4px;">#</th>
      <th style="text-align:left;padding:3px 4px;">DRONE</th>
      <th style="text-align:left;padding:3px 4px;">MOTOR</th>
      <th style="text-align:left;padding:3px 4px;">LOFT</th>
      <th style="text-align:left;padding:3px 4px;">RANGE</th>
      <th style="text-align:right;padding:3px 4px;">KILL RATE</th>
      <th style="text-align:right;padding:3px 4px;">K/M</th>
      <th style="text-align:right;padding:3px 4px;">AVG T</th>
    </tr>`;
  top5.forEach((r, i) => {
    const p = r.params, res = r.result;
    const pct = Math.round(res.killRate * 100);
    const col = pct >= 70 ? '#00ff88' : pct >= 40 ? '#ffcc00' : '#ff2233';
    tableHtml += `<tr style="border-bottom:1px solid #0a1a0a;">
      <td style="padding:3px 4px;color:#556655;">${i+1}</td>
      <td style="padding:3px 4px;">${p.droneType}@${p.droneAlt}m</td>
      <td style="padding:3px 4px;color:#ffcc00;">${p.motorKey.toUpperCase()}</td>
      <td style="padding:3px 4px;">${p.loftAngle}°</td>
      <td style="padding:3px 4px;">${p.launchRange}m</td>
      <td style="padding:3px 4px;text-align:right;color:${col};font-weight:bold;">${pct}%</td>
      <td style="padding:3px 4px;text-align:right;">${res.kills}/${res.misses}</td>
      <td style="padding:3px 4px;text-align:right;">${res.avgKillTime ? res.avgKillTime.toFixed(1)+'s' : '—'}</td>
    </tr>`;
  });
  tableHtml += '</table>';
  document.getElementById('swTopTable').innerHTML = tableHtml;

  const json = JSON.stringify(results.map(r => ({
    drone: r.params.droneType, droneAlt: r.params.droneAlt, motor: r.params.motorKey,
    loftAngle: r.params.loftAngle, launchRange: r.params.launchRange,
    seekMode: r.params.seekMode, trajectMode: r.params.trajectMode,
    fragOn: r.params.fragOn, fragR: r.params.fragR, maxLatG: r.params.maxLatG,
    payloadMass: r.params.payloadMass, salvoSize: r.params.salvoSize,
    staggerInterval: r.params.staggerInterval, batchSpread: r.params.batchSpread,
    kills: r.result.kills, misses: r.result.misses,
    killRate: Math.round(r.result.killRate * 1000) / 10,
    avgKillTime: r.result.avgKillTime ? Math.round(r.result.avgKillTime * 10) / 10 : null,
    fired: r.result.fired, crashes: r.result.crashes,
  })), null, 2);
  document.getElementById('swJsonArea').value = json;
  document.getElementById('swResultsSection').style.display = 'block';
  document.getElementById('swResultsSection').scrollIntoView({ behavior: 'smooth' });
}
