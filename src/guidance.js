// Interceptor steering: seek modes, trajectory correction applied each physics tick.
import { logEvent } from './logger.js';

// ── Observation layer ──
// Produces track state from target truth.
// Currently perfect pass-through. When camera/FOV is added later,
// this function will add FOV cone checks, noise, track loss, and
// dead-reckoning extrapolation. The guidance law NEVER reads
// intc.target.wx/wy/wz directly — only through this interface.
export function getTrackState(intc) {
  const tgt = intc.target;
  if (!tgt || !tgt.alive) return null;
  return {
    px: tgt.wx,  py: tgt.wy,  pz: tgt.wz,   // observed position
    vx: tgt.vx,  vy: tgt.vy,  vz: tgt.vz,   // observed velocity
    confidence: 1.0,                           // 0..1, 1 = perfect lock
    age: 0,                                    // seconds since last real observation
  };
}

// Apply mid-flight guidance to intc for one physics substep of duration dt.
// Modifies intc.vx / vy / vz in place; logs terminal-phase transitions.
// Optional silent flag suppresses log calls (for headless sweep).
export function steerInterceptor(intc, dt, silent) {
  // At maxLatG === 0: passive fins only, no active guidance regardless of seekMode
  if (intc.maxLatG <= 0 || intc.seekMode === 'ballistic') return { effectiveLatG: 0 };

  const track = getTrackState(intc);
  if (!track) return { effectiveLatG: 0 };

  // Normalize legacy seek mode values
  const mode = (intc.seekMode === 'lead' || intc.seekMode === 'lead_terminal')
    ? 'lead_pn' : intc.seekMode;

  // ── Lofted climb phase: steer toward baked loft aim point ──
  if (intc.trajectMode === 'lofted' && intc.vz > 0) {
    // Keep prevLos fresh during loft so PN doesn't get a stale-LOS kick at transition
    if (mode === 'pn' || mode === 'lead_pn') {
      updatePrevLos(intc, track);
    }
    return steerTowardPoint(intc, dt, intc.aimX, intc.aimY, intc.aimZ);
  }

  // ── lead_pn: terminal phase check (35m threshold) ──
  if (mode === 'lead_pn' && !intc.terminalPhase) {
    const ttdx = track.px - intc.wx, ttdy = track.py - intc.wy, ttdz = track.pz - intc.wz;
    const distToTarget = Math.sqrt(ttdx*ttdx + ttdy*ttdy + ttdz*ttdz);
    if (distToTarget <= 35) {
      intc.terminalPhase = true;
      if (!silent) {
        logEvent(`◈ TERMINAL PHASE — I${intc.id} switching to boosted PN @ ${distToTarget.toFixed(1)}m`, 'terminal');
      }
    }
  }

  // ── Pursuit mode: pure pursuit toward current position ──
  if (mode === 'pursuit') {
    return steerTowardPoint(intc, dt, track.px, track.py, track.pz);
  }

  // ── PN and Lead+PN: true proportional navigation ──
  if (mode === 'pn' || mode === 'lead_pn') {
    return steerPN(intc, dt, track, mode);
  }

  // Fallback: no steering
  return { effectiveLatG: 0 };
}

// ── Pure pursuit / waypoint steer: Δv⊥ toward a point ──
function steerTowardPoint(intc, dt, px, py, pz) {
  const tdx = px - intc.wx, tdy = py - intc.wy, tdz = pz - intc.wz;
  const td3 = Math.sqrt(tdx*tdx + tdy*tdy + tdz*tdz);
  if (td3 <= 0.1) return { effectiveLatG: 0 };

  const cs = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
  if (cs <= 0.1) return { effectiveLatG: 0 };

  const effectiveLatG = computeEffectiveLatG(intc, cs);
  const maxLatAccel = effectiveLatG * 9.81;

  // Desired velocity direction: unit vector toward target at current speed
  const dvx = (tdx/td3)*cs - intc.vx;
  const dvy = (tdy/td3)*cs - intc.vy;
  const dvz = (tdz/td3)*cs - intc.vz;

  applyLateralDv(intc, dt, dvx, dvy, dvz, maxLatAccel, cs);

  return { effectiveLatG };
}

// ── True Proportional Navigation ──
function steerPN(intc, dt, track, mode) {
  const cs = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
  if (cs <= 0.1) return { effectiveLatG: 0 };

  // LOS vector from interceptor to target
  const losX = track.px - intc.wx;
  const losY = track.py - intc.wy;
  const losZ = track.pz - intc.wz;
  const losR = Math.sqrt(losX*losX + losY*losY + losZ*losZ);
  if (losR <= 0.1) return { effectiveLatG: 0 };

  // LOS unit vector
  const losUx = losX/losR, losUy = losY/losR, losUz = losZ/losR;

  // LOS rotation rate from previous tick's unit vector
  const dLosX = losUx - intc.prevLosUx;
  const dLosY = losUy - intc.prevLosUy;
  const dLosZ = losUz - intc.prevLosUz;
  const omegaX = dLosX / dt;
  const omegaY = dLosY / dt;
  const omegaZ = dLosZ / dt;
  const omegaMag = Math.sqrt(omegaX*omegaX + omegaY*omegaY + omegaZ*omegaZ);

  // Update stored LOS for next tick
  intc.prevLosUx = losUx;
  intc.prevLosUy = losUy;
  intc.prevLosUz = losUz;

  // Closing speed (positive when closing):
  // relV = v_missile - v_target; project onto LOS (missile→target).
  // Positive dot means missile approaches target along LOS.
  const relVx = intc.vx - track.vx;
  const relVy = intc.vy - track.vy;
  const relVz = intc.vz - track.vz;
  const closingSpeed = relVx*losUx + relVy*losUy + relVz*losUz;

  // Navigation gain: N=3 normal, N=5 in terminal phase for lead_pn
  const N = (mode === 'lead_pn' && intc.terminalPhase) ? 5 : 3;
  const aCmdMag = N * closingSpeed * omegaMag;  // m/s²

  const effectiveLatG = computeEffectiveLatG(intc, cs);
  const maxLatAccel = effectiveLatG * 9.81;

  if (aCmdMag < 0.001 || omegaMag < 1e-8) {
    // LOS rate effectively zero — on collision course, no correction needed
    return { effectiveLatG };
  }

  // Direction of PN acceleration: omega vector with velocity-parallel component removed
  const ux = intc.vx/cs, uy = intc.vy/cs, uz = intc.vz/cs;
  const omDotU = omegaX*ux + omegaY*uy + omegaZ*uz;
  let perpOmX = omegaX - omDotU*ux;
  let perpOmY = omegaY - omDotU*uy;
  let perpOmZ = omegaZ - omDotU*uz;
  const perpOmMag = Math.sqrt(perpOmX*perpOmX + perpOmY*perpOmY + perpOmZ*perpOmZ);

  if (perpOmMag < 1e-8) return { effectiveLatG };

  // Scale to commanded acceleration magnitude, capped by maxLatAccel
  const appliedAccel = Math.min(aCmdMag, maxLatAccel);
  const scale = appliedAccel / perpOmMag;

  // Apply as lateral Δv
  const maxPerpDv = maxLatAccel * dt;
  const dvx = perpOmX * scale * dt;
  const dvy = perpOmY * scale * dt;
  const dvz = perpOmZ * scale * dt;
  const dvMag = Math.sqrt(dvx*dvx + dvy*dvy + dvz*dvz);
  const clamp = dvMag > maxPerpDv ? maxPerpDv / dvMag : 1.0;

  intc.vx += dvx * clamp;
  intc.vy += dvy * clamp;
  intc.vz += dvz * clamp;

  // Renormalize to preserve speed (steering rotates direction, not magnitude)
  const ns = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
  if (ns > 0.1) { const f = cs/ns; intc.vx *= f; intc.vy *= f; intc.vz *= f; }

  return { effectiveLatG };
}

// ── Update prevLos to current LOS (keeps PN rate computation fresh across all phases) ──
function updatePrevLos(intc, track) {
  const losX = track.px - intc.wx;
  const losY = track.py - intc.wy;
  const losZ = track.pz - intc.wz;
  const losR = Math.sqrt(losX*losX + losY*losY + losZ*losZ);
  if (losR > 0.1) {
    intc.prevLosUx = losX / losR;
    intc.prevLosUy = losY / losR;
    intc.prevLosUz = losZ / losR;
  }
}

// ── Dynamic-pressure scaled lateral G ──
function computeEffectiveLatG(intc, cs) {
  let effectiveLatG = intc.maxLatG;
  const refSpd = intc.burnoutSpd ?? cs;
  if (refSpd > 0) {
    const spdRatio = cs / refSpd;
    effectiveLatG = intc.maxLatG * spdRatio * spdRatio;
    const latGFloor = 0.02 * intc.maxLatG;
    effectiveLatG = Math.max(latGFloor, Math.min(intc.maxLatG, effectiveLatG));
  }
  return effectiveLatG;
}

// ── Apply lateral Δv (perpendicular-only, speed renormalized) ──
function applyLateralDv(intc, dt, dvx, dvy, dvz, maxLatAccel, cs) {
  const ux = intc.vx/cs, uy = intc.vy/cs, uz = intc.vz/cs;
  const parDot = dvx*ux + dvy*uy + dvz*uz;
  const perpx = dvx - parDot*ux;
  const perpy = dvy - parDot*uy;
  const perpz = dvz - parDot*uz;
  const perpMag = Math.sqrt(perpx*perpx + perpy*perpy + perpz*perpz);

  const maxPerpDv = maxLatAccel * dt;
  const scale = perpMag > maxPerpDv ? maxPerpDv / perpMag : 1.0;

  intc.vx += perpx * scale;
  intc.vy += perpy * scale;
  intc.vz += perpz * scale;

  // Renormalize to preserve speed
  const ns = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
  if (ns > 0.1) { const f = cs/ns; intc.vx *= f; intc.vy *= f; intc.vz *= f; }
}
