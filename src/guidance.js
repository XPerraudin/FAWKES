// Interceptor steering: seek modes, trajectory correction applied each physics tick.
import { logEvent } from './logger.js';

// Apply mid-flight guidance to intc for one physics substep of duration dt.
// Modifies intc.vx / vy / vz in place; logs terminal-phase transitions.
export function steerInterceptor(intc, dt) {
  // At maxLatG === 0: passive fins only, no active guidance regardless of seekMode
  if (intc.maxLatG <= 0 || intc.seekMode === 'ballistic' || !intc.target.alive) return;

  // ── lead_terminal: check 35m threshold and flip terminalPhase ──
  if (intc.seekMode === 'lead_terminal' && !intc.terminalPhase && intc.target.alive) {
    const ttdx = intc.target.wx - intc.wx, ttdy = intc.target.wy - intc.wy, ttdz = intc.target.wz - intc.wz;
    const distToTarget = Math.sqrt(ttdx*ttdx + ttdy*ttdy + ttdz*ttdz);
    if (distToTarget <= 35) {
      intc.terminalPhase = true;
      logEvent(`◈ TERMINAL PHASE — I${intc.id} switching to pure pursuit @ ${distToTarget.toFixed(1)}m`, 'terminal');
    }
  }

  // Determine steer target position
  let steerX, steerY, steerZ;
  if (intc.seekMode === 'lead_terminal' && intc.terminalPhase) {
    // Terminal phase: ignore loft apex, home directly on live drone position
    steerX = intc.target.wx; steerY = intc.target.wy; steerZ = intc.target.wz;
  } else if (intc.trajectMode === 'lofted' && intc.vz > 0) {
    steerX = intc.aimX; steerY = intc.aimY; steerZ = intc.aimZ;
  } else if (intc.seekMode === 'lead' || intc.seekMode === 'lead_terminal') {
    // Lead / Lead+terminal outside terminal range: home on live drone position
    steerX = intc.target.wx; steerY = intc.target.wy; steerZ = intc.target.wz;
  } else {
    // pursuit or pn: always live position
    steerX = intc.target.wx; steerY = intc.target.wy; steerZ = intc.target.wz;
  }

  const tdx = steerX - intc.wx, tdy = steerY - intc.wy, tdz = steerZ - intc.wz;
  const td3 = Math.sqrt(tdx*tdx + tdy*tdy + tdz*tdz);
  if (td3 <= 0.1) return;

  const cs = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
  if (cs <= 0.1) return;

  // ── Physically-derived lateral acceleration cap ──
  const turnScale   = intc.effectiveTurnRate / 90.0;  // 0..1 from payload mass
  const maxLatAccel = intc.maxLatG * 9.81 * turnScale; // m/s²

  // Desired velocity direction: unit vector toward steer target, at current speed
  const dvx = (tdx/td3)*cs - intc.vx;
  const dvy = (tdy/td3)*cs - intc.vy;
  const dvz = (tdz/td3)*cs - intc.vz;

  // Current velocity unit vector (parallel axis)
  const ux = intc.vx/cs, uy = intc.vy/cs, uz = intc.vz/cs;

  // Decompose desired Δv into parallel + perpendicular components.
  // parDot is the speed-change component (along current heading) — ignored for
  // steering; thrust/drag handle speed. We only apply the lateral (perp) part.
  const parDot  = dvx*ux + dvy*uy + dvz*uz;
  const perpx   = dvx - parDot*ux;   // lateral correction vector
  const perpy   = dvy - parDot*uy;
  const perpz   = dvz - parDot*uz;
  const perpMag = Math.sqrt(perpx*perpx + perpy*perpy + perpz*perpz);

  // Cap lateral Δv to maxLatAccel * dt, then apply ONLY the perp component
  const maxPerpDv = maxLatAccel * dt;
  const scale     = perpMag > maxPerpDv ? maxPerpDv / perpMag : 1.0;

  intc.vx += perpx * scale;
  intc.vy += perpy * scale;
  intc.vz += perpz * scale;

  // Renormalize to preserve speed (steering rotates direction, not magnitude)
  const ns = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
  if (ns > 0.1) { const f = cs/ns; intc.vx *= f; intc.vy *= f; intc.vz *= f; }
}
