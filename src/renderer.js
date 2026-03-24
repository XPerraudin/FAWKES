// All canvas draw functions: top/iso/side views, grid, entities, overlays.
import { PX, DRONE_TYPES } from './constants.js';
import state, { canvas, ctx } from './state.js';

// ── Resize canvas to its CSS-rendered size ──
export function resize() {
  canvas.width  = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}

// ── ISO pitch → elevation scale factors ──
export function isoScales() {
  const elev = 0.05 + state.isoPitch * 1.10;  // radians: ~3° to ~68°
  return {
    hScale: Math.cos(elev) * 0.9,
    vGnd:   Math.sin(elev) * 0.55,
    vAlt:   0.72,
  };
}

// ── Dynamic pixels-per-metre for TOP and SIDE views ──
export function viewPX() {
  const W = canvas.width, H = canvas.height;
  return Math.min(W, H) / state.mapFieldSize;
}

// ── Convert a world-space radius to screen pixels ──
export function worldR(r) {
  return state.viewMode === 'iso' ? r * PX * state.isoZoom : r * viewPX();
}

// ── World meters → screen pixels ──
export function proj(wx, wy, wz) {
  const W = canvas.width, H = canvas.height;
  if (state.viewMode === 'top') {
    const vpx = viewPX();
    return { sx: wx*vpx, sy: wy*vpx };
  }
  if (state.viewMode === 'side') {
    const vpx = viewPX();
    return { sx: wx*vpx, sy: H - 30 - wz*vpx*0.9*state.sideAltScale };
  }
  // ISO — yaw-rotate world XY around map centre, then apply pitch-scaled projection
  const cx = state.mapFieldSize * 0.5, cy = state.mapFieldSize * 0.5;
  const dx = wx - cx, dy = wy - cy;
  const cosA = Math.cos(state.isoAngle), sinA = Math.sin(state.isoAngle);
  const rx = dx*cosA - dy*sinA + cx;
  const ry = dx*sinA + dy*cosA + cy;
  const { hScale, vGnd, vAlt } = isoScales();
  const iz = PX * state.isoZoom;
  const ix = (rx - ry) * hScale * iz + W * 0.5;
  const iy = (rx + ry) * vGnd  * iz + H * 0.38 - wz * iz * vAlt;
  return { sx: ix, sy: iy };
}

// ── Inverse projection: screen pixels → world meters at z=0 ──
export function screenToWorld(sx, sy) {
  const W = canvas.width, H = canvas.height;
  if (state.viewMode === 'top') {
    const vpx = viewPX();
    return { wx: sx/vpx, wy: sy/vpx };
  }
  if (state.viewMode === 'side') {
    const vpx = viewPX();
    return { wx: sx/vpx, wy: state.mapFieldSize * 0.5 };
  }
  // ISO inverse (at wz=0), then un-rotate
  const { hScale, vGnd } = isoScales();
  const iz = PX * state.isoZoom;
  const A = (sx - W*0.5) / (hScale * iz);
  const B = (sy - H*0.38) / (vGnd  * iz);
  const rx = (A+B)*0.5, ry = (B-A)*0.5;
  const cx = state.mapFieldSize * 0.5, cy = state.mapFieldSize * 0.5;
  const dx = rx - cx, dy = ry - cy;
  const cosA = Math.cos(-state.isoAngle), sinA = Math.sin(-state.isoAngle);
  return { wx: dx*cosA - dy*sinA + cx, wy: dx*sinA + dy*cosA + cy };
}

// ── Grid/scale helper: pick a "nice" world-metre step ──
function niceMetreStep(targetScreenPx, pxPerM) {
  const nice = [100, 200, 250, 500, 1000];
  const ideal = targetScreenPx / pxPerM;
  for (const n of nice) { if (n >= ideal) return n; }
  return nice[nice.length - 1];
}

function drawGrid() {
  const W = canvas.width, H = canvas.height;
  const vpx = viewPX();
  const gridStep = niceMetreStep(60, vpx);

  ctx.lineWidth = 1;
  if (state.viewMode === 'side') {
    const rawStep = 100;
    const screenPixPerStep = rawStep * vpx * 0.9 * state.sideAltScale;
    const step = screenPixPerStep < 20 ? rawStep * Math.ceil(20/screenPixPerStep) : rawStep;
    for (let a = 0; a <= 3000; a += step) {
      const p = proj(0, 0, a);
      if (p.sy < 0 || p.sy > H) continue;
      ctx.strokeStyle = a === 0 ? '#2a5535' : '#152a1e';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(42, p.sy); ctx.lineTo(W, p.sy); ctx.stroke();
      if (a > 0) {
        ctx.fillStyle = '#55cc88'; ctx.font = 'bold 9px Share Tech Mono';
        ctx.fillText(a + 'm', 44, p.sy - 3);
      }
    }
    for (let x = 0; x <= state.mapFieldSize; x += gridStep) {
      const sx = x * vpx;
      if (sx < 42 || sx > W) continue;
      ctx.strokeStyle = '#0d1e12'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
      ctx.fillStyle = '#1e5535'; ctx.font = '8px Share Tech Mono';
      ctx.fillText(x + 'm', sx + 2, H - 4);
    }
  } else if (state.viewMode === 'top') {
    for (let x = 0; x <= state.mapFieldSize; x += gridStep) {
      const sx = x * vpx;
      ctx.strokeStyle = '#0d1e12'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
      if (x > 0) { ctx.fillStyle = '#1e5535'; ctx.font = '8px Share Tech Mono'; ctx.fillText(x + 'm', sx + 2, 10); }
    }
    for (let y = 0; y <= state.mapFieldSize; y += gridStep) {
      const sy = y * vpx;
      ctx.strokeStyle = '#0d1e12'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
      if (y > 0) { ctx.fillStyle = '#1e5535'; ctx.font = '8px Share Tech Mono'; ctx.fillText(y + 'm', 2, sy - 2); }
    }
  } else if (state.viewMode === 'iso') {
    const step = gridStep;
    const cols = Math.round(state.mapFieldSize / step);
    const rows = cols;
    for (let r = 0; r <= rows; r++) {
      const wy = r * step;
      const p0 = proj(0, wy, 0), p1 = proj(cols*step, wy, 0);
      ctx.strokeStyle = 'rgba(30,80,50,0.45)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy); ctx.stroke();
    }
    for (let c = 0; c <= cols; c++) {
      const wx = c * step;
      const p0 = proj(wx, 0, 0), p1 = proj(wx, rows*step, 0);
      ctx.strokeStyle = 'rgba(30,80,50,0.45)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy); ctx.stroke();
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p00 = proj(c*step,     r*step,     0);
        const p10 = proj((c+1)*step, r*step,     0);
        const p11 = proj((c+1)*step, (r+1)*step, 0);
        const p01 = proj(c*step,     (r+1)*step, 0);
        ctx.fillStyle = (r+c)%2 === 0 ? 'rgba(12,28,18,0.55)' : 'rgba(8,20,14,0.55)';
        ctx.beginPath();
        ctx.moveTo(p00.sx,p00.sy); ctx.lineTo(p10.sx,p10.sy);
        ctx.lineTo(p11.sx,p11.sy); ctx.lineTo(p01.sx,p01.sy);
        ctx.closePath(); ctx.fill();
      }
    }
    // ── Altitude reference planes with crisp labels ──
    const FIELD = state.mapFieldSize;
    if (state.showScales) {
      for (let a = 100; a <= 500; a += 100) {
        const p0 = proj(0, 0, a), p1 = proj(FIELD, 0, a);
        ctx.strokeStyle = `rgba(0,255,136,0.10)`; ctx.lineWidth = 1;
        ctx.setLineDash([5, 7]);
        ctx.beginPath(); ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy); ctx.stroke();
        ctx.setLineDash([]);
        const label = a + 'm';
        ctx.font = 'bold 11px Share Tech Mono';
        const tw = ctx.measureText(label).width;
        const lx = p0.sx + 6, ly = p0.sy - 5;
        ctx.fillStyle = 'rgba(4,12,8,0.82)';
        ctx.fillRect(lx - 2, ly - 10, tw + 6, 14);
        ctx.fillStyle = '#55ffaa';
        ctx.fillText(label, lx, ly);
      }

      const edgeLabel = (text, sx, sy, alignRight) => {
        ctx.font = 'bold 11px Share Tech Mono';
        const tw = ctx.measureText(text).width;
        const lx = alignRight ? sx - tw - 4 : sx + 4;
        const ly = sy + 4;
        ctx.fillStyle = 'rgba(4,12,8,0.82)';
        ctx.fillRect(lx - 2, ly - 10, tw + 6, 14);
        ctx.fillStyle = '#44ddaa';
        ctx.fillText(text, lx, ly);
      };

      const scaleStep = FIELD <= 1000 ? 200 : FIELD <= 2000 ? 500 : 1000;
      for (let x = 0; x <= FIELD; x += scaleStep) {
        const pGnd  = proj(x, 0, 0), pTick = proj(x, 0, 14);
        ctx.strokeStyle = 'rgba(0,200,100,0.65)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(pGnd.sx, pGnd.sy); ctx.lineTo(pTick.sx, pTick.sy); ctx.stroke();
        if (x > 0) edgeLabel(x + 'm', pGnd.sx, pGnd.sy + 10, false);
      }
      for (let y = 0; y <= FIELD; y += scaleStep) {
        const pGnd  = proj(0, y, 0), pTick = proj(0, y, 14);
        ctx.strokeStyle = 'rgba(0,170,90,0.60)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(pGnd.sx, pGnd.sy); ctx.lineTo(pTick.sx, pTick.sy); ctx.stroke();
        if (y > 0) edgeLabel(y + 'm', pGnd.sx, pGnd.sy + 10, true);
      }
    }
  }
}

function drawScaleSquare() {
  const W = canvas.width, H = canvas.height;
  const vpx = viewPX();
  const PAD = 14;
  const margin = state.viewMode === 'side' ? PAD + 44 : PAD;

  if (state.viewMode === 'top' || state.viewMode === 'side') {
    const cellM  = niceMetreStep(60, vpx);
    const cellPx = cellM * vpx;
    const bx = margin + 6;
    const by = H - PAD - cellPx - 22;
    const panW = cellPx + 20, panH = cellPx + 26;
    ctx.fillStyle = 'rgba(4,10,8,0.82)';
    ctx.fillRect(bx - 6, by - 4, panW, panH);
    ctx.strokeStyle = '#1e4a2a'; ctx.lineWidth = 1;
    ctx.strokeRect(bx - 6, by - 4, panW, panH);
    ctx.strokeStyle = '#44cc88'; ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(bx, by, cellPx, cellPx);
    ctx.fillStyle = 'rgba(0,180,80,0.06)';
    ctx.fillRect(bx, by, cellPx, cellPx);
    const tk = 5;
    ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 1.5;
    [[bx,by],[bx+cellPx,by],[bx,by+cellPx],[bx+cellPx,by+cellPx]].forEach(([cx,cy],i) => {
      const sx = i%2===0 ? 1 : -1, sy2 = i<2 ? 1 : -1;
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+sx*tk,cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx,cy+sy2*tk); ctx.stroke();
    });
    ctx.fillStyle = '#77ffaa'; ctx.font = 'bold 9px Share Tech Mono';
    ctx.textAlign = 'center';
    ctx.fillText(cellM + 'm × ' + cellM + 'm', bx + cellPx*0.5, by + cellPx + 14);
    ctx.textAlign = 'left';
  } else if (state.viewMode === 'iso') {
    const cellM = niceMetreStep(60, vpx);
    const ox = 0, oy = state.mapFieldSize;
    const p00 = proj(ox,       oy,       0);
    const p10 = proj(ox+cellM, oy,       0);
    const p11 = proj(ox+cellM, oy-cellM, 0);
    const p01 = proj(ox,       oy-cellM, 0);
    const xs = [p00.sx,p10.sx,p11.sx,p01.sx], ys = [p00.sy,p10.sy,p11.sy,p01.sy];
    const bx2 = Math.min(...xs)-8, by2 = Math.min(...ys)-8;
    const bw  = Math.max(...xs)-bx2+8, bh2 = Math.max(...ys)-by2+24;
    ctx.fillStyle = 'rgba(4,10,8,0.82)';
    ctx.fillRect(bx2, by2, bw, bh2);
    ctx.strokeStyle = '#1e4a2a'; ctx.lineWidth = 1;
    ctx.strokeRect(bx2, by2, bw, bh2);
    ctx.fillStyle = 'rgba(0,180,80,0.10)';
    ctx.beginPath();
    ctx.moveTo(p00.sx,p00.sy); ctx.lineTo(p10.sx,p10.sy);
    ctx.lineTo(p11.sx,p11.sy); ctx.lineTo(p01.sx,p01.sy);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#44cc88'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(p00.sx,p00.sy); ctx.lineTo(p10.sx,p10.sy);
    ctx.lineTo(p11.sx,p11.sy); ctx.lineTo(p01.sx,p01.sy);
    ctx.closePath(); ctx.stroke();
    ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 1.5;
    [[p00,p10,p01],[p10,p11,p00],[p11,p01,p10],[p01,p00,p11]].forEach(([pt,na,nb]) => {
      const ax = (na.sx-pt.sx), ay = (na.sy-pt.sy), al = Math.sqrt(ax*ax+ay*ay)||1;
      const bx3 = (nb.sx-pt.sx), by3 = (nb.sy-pt.sy), bl = Math.sqrt(bx3*bx3+by3*by3)||1;
      ctx.beginPath(); ctx.moveTo(pt.sx,pt.sy); ctx.lineTo(pt.sx+ax/al*5,pt.sy+ay/al*5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pt.sx,pt.sy); ctx.lineTo(pt.sx+bx3/bl*5,pt.sy+by3/bl*5); ctx.stroke();
    });
    const labelY = Math.max(...ys) + 14;
    const labelX = (p00.sx + p10.sx) * 0.5;
    ctx.fillStyle = '#77ffaa'; ctx.font = 'bold 9px Share Tech Mono';
    ctx.textAlign = 'center';
    ctx.fillText(cellM + 'm × ' + cellM + 'm', labelX, labelY);
    ctx.textAlign = 'left';
  }
}

export function drawFullPaths() {
  if (!state.simEnded || !state.showFullPaths) return;
  ctx.save();
  for (const d of state.drones) {
    if (d.fullPath.length < 2) continue;
    if (state.showKillsOnly && !d.wasKilled) continue;
    ctx.globalAlpha = state.showKillsOnly ? 0.55 : 0.38;
    ctx.strokeStyle = d.type.color;
    ctx.lineWidth = state.showKillsOnly ? 1.5 : 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    const p0 = proj(d.fullPath[0].wx, d.fullPath[0].wy, d.fullPath[0].wz);
    ctx.moveTo(p0.sx, p0.sy);
    for (let i = 1; i < d.fullPath.length; i++) {
      const p = proj(d.fullPath[i].wx, d.fullPath[i].wy, d.fullPath[i].wz);
      ctx.lineTo(p.sx, p.sy);
    }
    ctx.stroke();
  }
  for (const intc of state.interceptors) {
    if (intc.fullPath.length < 2) continue;
    if (state.showKillsOnly && !intc.wasKill) continue;
    ctx.globalAlpha = state.showKillsOnly ? 0.65 : 0.30;
    ctx.strokeStyle = state.showKillsOnly ? '#00ff88' : '#00cc66';
    ctx.lineWidth = state.showKillsOnly ? 1.5 : 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    const p0 = proj(intc.fullPath[0].wx, intc.fullPath[0].wy, intc.fullPath[0].wz);
    ctx.moveTo(p0.sx, p0.sy);
    for (let i = 1; i < intc.fullPath.length; i++) {
      const p = proj(intc.fullPath[i].wx, intc.fullPath[i].wy, intc.fullPath[i].wz);
      ctx.lineTo(p.sx, p.sy);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawTrails(entities, colorFn) {
  for (const e of entities) {
    if (e.trail.length < 2) continue;
    const color = colorFn(e);
    for (let i = 1; i < e.trail.length; i++) {
      ctx.globalAlpha = (i / e.trail.length) * 0.5;
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      const a = proj(e.trail[i-1].wx, e.trail[i-1].wy, e.trail[i-1].wz);
      const b = proj(e.trail[i].wx,   e.trail[i].wy,   e.trail[i].wz);
      ctx.beginPath(); ctx.moveTo(a.sx,a.sy); ctx.lineTo(b.sx,b.sy); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

// Burning → bright green; coasting → dim amber-grey
export function intcColor(intc) {
  return intc.burnRemaining > 0 ? '#00ff88' : '#c07830';
}

function drawDrone(sx, sy, d) {
  if (state.viewMode === 'iso') { isoDrawDrone(d); return; }
  ctx.save(); ctx.translate(sx, sy);
  const ascale = state.viewMode === 'top' ? Math.max(0.55, 1 - d.wz/1400) : 1;
  ctx.scale(ascale, ascale); ctx.rotate(d.angle);
  ctx.shadowColor = d.type.color; ctx.shadowBlur = 10;
  if (d.type === DRONE_TYPES.shahed) {
    ctx.fillStyle = d.type.color;
    ctx.beginPath(); ctx.moveTo(12,0); ctx.lineTo(-9,-8); ctx.lineTo(-5,0); ctx.lineTo(-9,8); ctx.closePath(); ctx.fill();
  } else if (d.type === DRONE_TYPES.quadcopter) {
    ctx.strokeStyle = d.type.color; ctx.lineWidth = 2; ctx.fillStyle = d.type.color;
    for (let a = 0; a < 4; a++) {
      ctx.save(); ctx.rotate(a*Math.PI/2 + Math.PI/4);
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(9,0); ctx.stroke();
      ctx.beginPath(); ctx.arc(9,0,3,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(0,0,3,0,Math.PI*2); ctx.fill();
  } else {
    ctx.fillStyle = d.type.color; ctx.strokeStyle = '#ffdd8866'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = i*Math.PI/3; i === 0 ? ctx.moveTo(Math.cos(a)*8,Math.sin(a)*8) : ctx.lineTo(Math.cos(a)*8,Math.sin(a)*8); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.shadowBlur = 0; ctx.restore();
}

function drawInterceptor(sx, sy, intc) {
  if (state.viewMode === 'iso') { isoDrawInterceptor(intc); return; }
  const col = intcColor(intc);
  ctx.save(); ctx.translate(sx, sy);
  const screenAng = Math.atan2(intc.vy, intc.vx);
  ctx.rotate(screenAng);
  ctx.shadowColor = col; ctx.shadowBlur = 14;
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(12,0); ctx.lineTo(-5,-3.5); ctx.lineTo(-3,0); ctx.lineTo(-5,3.5); ctx.closePath(); ctx.fill();
  if (intc.burnRemaining > 0) {
    const fl = 7 + Math.random()*9, fw = 3;
    if (isFinite(fl) && fl > 0) {
      const gr = ctx.createLinearGradient(-3,0,-3-fl,0);
      gr.addColorStop(0,'rgba(255,200,60,0.95)'); gr.addColorStop(0.4,'rgba(255,100,10,0.7)'); gr.addColorStop(1,'transparent');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.moveTo(-3,-fw); ctx.lineTo(-3-fl,0); ctx.lineTo(-3,fw); ctx.closePath(); ctx.fill();
    }
  }
  ctx.shadowBlur = 0; ctx.restore();
}

// ── ISO 3D box helper ──
function isoBox(wx, wy, wz, sw, sd, sh, cTop, cLeft, cRight, strokeC) {
  const p000 = proj(wx,    wy,    wz   );
  const p100 = proj(wx+sw, wy,    wz   );
  const p110 = proj(wx+sw, wy+sd, wz   );
  const p010 = proj(wx,    wy+sd, wz   );
  const p001 = proj(wx,    wy,    wz+sh);
  const p101 = proj(wx+sw, wy,    wz+sh);
  const p111 = proj(wx+sw, wy+sd, wz+sh);
  const p011 = proj(wx,    wy+sd, wz+sh);

  ctx.beginPath();
  ctx.moveTo(p100.sx,p100.sy); ctx.lineTo(p110.sx,p110.sy);
  ctx.lineTo(p111.sx,p111.sy); ctx.lineTo(p101.sx,p101.sy);
  ctx.closePath(); ctx.fillStyle = cRight; ctx.fill();
  if (strokeC) { ctx.strokeStyle = strokeC; ctx.lineWidth = 0.8; ctx.stroke(); }

  ctx.beginPath();
  ctx.moveTo(p010.sx,p010.sy); ctx.lineTo(p110.sx,p110.sy);
  ctx.lineTo(p111.sx,p111.sy); ctx.lineTo(p011.sx,p011.sy);
  ctx.closePath(); ctx.fillStyle = cLeft; ctx.fill();
  if (strokeC) { ctx.strokeStyle = strokeC; ctx.lineWidth = 0.8; ctx.stroke(); }

  ctx.beginPath();
  ctx.moveTo(p001.sx,p001.sy); ctx.lineTo(p101.sx,p101.sy);
  ctx.lineTo(p111.sx,p111.sy); ctx.lineTo(p011.sx,p011.sy);
  ctx.closePath(); ctx.fillStyle = cTop; ctx.fill();
  if (strokeC) { ctx.strokeStyle = strokeC; ctx.lineWidth = 0.8; ctx.stroke(); }
}

function isoDrawTarget(twx, twy) {
  const p = proj(twx, twy, 0);
  const rings = [{r:60,c:'rgba(51,170,255,0.12)'},{r:40,c:'rgba(51,170,255,0.18)'},{r:22,c:'rgba(51,170,255,0.28)'},{r:10,c:'rgba(51,170,255,0.5)'}];
  for (const ring of rings) {
    ctx.strokeStyle = ring.c; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy, worldR(ring.r), worldR(ring.r)*0.45, -0.52, 0, Math.PI*2);
    ctx.stroke();
  }
  const hs = 2.5;
  isoBox(twx-hs, twy-hs, 0, hs*2, hs*2, 2, '#1a3a5a','#0d2040','#102a50','#33aaff44');
  const cp = proj(twx, twy, 2);
  ctx.fillStyle = '#33aaff'; ctx.shadowColor = '#33aaff'; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(cp.sx, cp.sy, 5, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
}

function isoDrawLauncher(lwx, lwy) {
  isoBox(lwx-4, lwy-4, 0, 8, 8, 4, '#2a2a00','#1a1a00','#222200','#cccc0088');
  isoBox(lwx-3, lwy-3, 4, 6, 6, 1, '#3a3a00','#252500','#2e2e00','#dddd0066');
  const elevDeg = parseInt(document.getElementById('launchElev').value);
  const elevR   = elevDeg * Math.PI / 180;
  const tubeLen = 12;
  const tx = lwx + Math.cos(elevR)*tubeLen*0.7;
  const ty = lwy;
  const tz = 5 + Math.sin(elevR)*tubeLen;
  const pb = proj(lwx, lwy, 5), pt = proj(tx, ty, tz);
  ctx.strokeStyle = '#ffff00'; ctx.lineWidth = 3;
  ctx.shadowColor = '#ffff44'; ctx.shadowBlur = 6;
  ctx.beginPath(); ctx.moveTo(pb.sx, pb.sy); ctx.lineTo(pt.sx, pt.sy); ctx.stroke();
  ctx.shadowBlur = 0;
}

function isoDrawDrone(d) {
  const c = d.type.color;
  ctx.shadowColor = c; ctx.shadowBlur = 12;

  if (d.type === DRONE_TYPES.shahed) {
    const fwd = 6, bk = 2, hw = 3, ht = 1.5;
    const hdg = d.angle;
    const fx  = d.wx + Math.cos(hdg)*fwd, fy = d.wy + Math.sin(hdg)*fwd;
    const blx = d.wx + Math.cos(hdg+Math.PI)*bk + Math.cos(hdg-Math.PI/2)*hw;
    const bly = d.wy + Math.sin(hdg+Math.PI)*bk + Math.sin(hdg-Math.PI/2)*hw;
    const brx = d.wx + Math.cos(hdg+Math.PI)*bk + Math.cos(hdg+Math.PI/2)*hw;
    const bry = d.wy + Math.sin(hdg+Math.PI)*bk + Math.sin(hdg+Math.PI/2)*hw;
    const wz = d.wz, wzt = d.wz + ht;
    const pf0  = proj(fx, fy, wz),  pbl0 = proj(blx, bly, wz),  pbr0 = proj(brx, bry, wz);
    const pf1  = proj(fx, fy, wzt), pbl1 = proj(blx, bly, wzt), pbr1 = proj(brx, bry, wzt);
    ctx.fillStyle = c + 'cc';
    ctx.beginPath(); ctx.moveTo(pf1.sx,pf1.sy); ctx.lineTo(pbl1.sx,pbl1.sy); ctx.lineTo(pbr1.sx,pbr1.sy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = c + '66';
    ctx.beginPath(); ctx.moveTo(pf0.sx,pf0.sy); ctx.lineTo(pbr0.sx,pbr0.sy); ctx.lineTo(pbr1.sx,pbr1.sy); ctx.lineTo(pf1.sx,pf1.sy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = c + '44';
    ctx.beginPath(); ctx.moveTo(pf0.sx,pf0.sy); ctx.lineTo(pbl0.sx,pbl0.sy); ctx.lineTo(pbl1.sx,pbl1.sy); ctx.lineTo(pf1.sx,pf1.sy); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = c; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pf1.sx,pf1.sy); ctx.lineTo(pbl1.sx,pbl1.sy); ctx.lineTo(pbr1.sx,pbr1.sy); ctx.closePath(); ctx.stroke();

  } else if (d.type === DRONE_TYPES.quadcopter) {
    isoBox(d.wx-2, d.wy-2, d.wz, 4, 4, 2, c+'bb', c+'66', c+'88', c+'99');
    const armLen = 7;
    for (let a = 0; a < 4; a++) {
      const ang = d.angle + a*Math.PI/2 + Math.PI/4;
      const ax = d.wx + Math.cos(ang)*armLen, ay = d.wy + Math.sin(ang)*armLen;
      const p0 = proj(d.wx, d.wy, d.wz+1), p1 = proj(ax, ay, d.wz+1);
      ctx.strokeStyle = c + '88'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy); ctx.stroke();
      const pr = proj(ax, ay, d.wz+1.5);
      ctx.strokeStyle = c + 'aa'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(pr.sx, pr.sy, 5, 2.2, -0.52, 0, Math.PI*2); ctx.stroke();
    }
  } else {
    isoBox(d.wx-2.5, d.wy-2.5, d.wz, 5, 5, 2, c+'cc', c+'77', c+'99', c+'88');
    const armL = 6;
    for (let a = 0; a < 4; a++) {
      const ang = d.angle + a*Math.PI/2;
      const ax = d.wx + Math.cos(ang)*armL, ay = d.wy + Math.sin(ang)*armL;
      const p0 = proj(d.wx, d.wy, d.wz+2), p1 = proj(ax, ay, d.wz+2);
      ctx.strokeStyle = c + '99'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy); ctx.stroke();
      const pr = proj(ax, ay, d.wz+2.5);
      ctx.strokeStyle = c + 'bb'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(pr.sx, pr.sy, 4.5, 2, -0.52, 0, Math.PI*2); ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;
}

function isoDrawInterceptor(intc) {
  const spd = Math.sqrt(intc.vx**2 + intc.vy**2 + intc.vz**2);
  const col  = intcColor(intc);
  ctx.shadowColor = col; ctx.shadowBlur = 16;

  const len = 5, wid = 1.2, ht = 1.2;
  const hspd2d = Math.sqrt(intc.vx**2 + intc.vy**2);
  const vn = hspd2d > 0.1 ? {x:intc.vx/hspd2d, y:intc.vy/hspd2d} : {x:1,y:0};
  const rn = {x:-vn.y, y:vn.x};
  const nx = intc.wx + vn.x*len*0.65, ny = intc.wy + vn.y*len*0.65;
  const tx = intc.wx - vn.x*len*0.35, ty = intc.wy - vn.y*len*0.35;
  const wz = intc.wz - ht/2, wzt = intc.wz + ht/2;
  const rx = rn.x*wid*0.5, ry = rn.y*wid*0.5;

  const pNoseT   = proj(nx,    ny,    wzt);
  const pTailRT  = proj(tx+rx, ty+ry, wzt);
  const pTailLT  = proj(tx-rx, ty-ry, wzt);
  const pNoseB   = proj(nx,    ny,    wz);
  const pTailRB  = proj(tx+rx, ty+ry, wz);
  const pTailLB  = proj(tx-rx, ty-ry, wz);

  const colTop   = col + 'cc';
  const colRight = intc.burnRemaining > 0 ? '#00aa5577' : '#7a4a1877';
  const colLeft  = intc.burnRemaining > 0 ? '#00884477' : '#5a360f77';

  ctx.fillStyle = colTop;
  ctx.beginPath(); ctx.moveTo(pNoseT.sx,pNoseT.sy); ctx.lineTo(pTailRT.sx,pTailRT.sy); ctx.lineTo(pTailLT.sx,pTailLT.sy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = colRight;
  ctx.beginPath(); ctx.moveTo(pNoseB.sx,pNoseB.sy); ctx.lineTo(pTailRB.sx,pTailRB.sy); ctx.lineTo(pTailRT.sx,pTailRT.sy); ctx.lineTo(pNoseT.sx,pNoseT.sy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = colLeft;
  ctx.beginPath(); ctx.moveTo(pNoseB.sx,pNoseB.sy); ctx.lineTo(pTailLB.sx,pTailLB.sy); ctx.lineTo(pTailLT.sx,pTailLT.sy); ctx.lineTo(pNoseT.sx,pNoseT.sy); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(pNoseT.sx,pNoseT.sy); ctx.lineTo(pTailRT.sx,pTailRT.sy); ctx.lineTo(pTailLT.sx,pTailLT.sy); ctx.closePath(); ctx.stroke();

  if (intc.burnRemaining > 0 && spd > 0.5) {
    const fl = 8 + Math.random()*10;
    const ex = intc.wx - vn.x*fl*0.5, ey = intc.wy - vn.y*fl*0.5;
    const pe   = proj(ex, ey, intc.wz);
    const pt2  = proj(tx, ty, intc.wz);
    if (isFinite(pt2.sx) && isFinite(pt2.sy) && isFinite(pe.sx) && isFinite(pe.sy) &&
        !(pt2.sx === pe.sx && pt2.sy === pe.sy)) {
      const flGrad = ctx.createLinearGradient(pt2.sx,pt2.sy,pe.sx,pe.sy);
      flGrad.addColorStop(0,'rgba(255,200,50,0.9)');
      flGrad.addColorStop(0.5,'rgba(255,80,10,0.5)');
      flGrad.addColorStop(1,'transparent');
      ctx.strokeStyle = flGrad; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(pt2.sx,pt2.sy); ctx.lineTo(pe.sx,pe.sy); ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;
}

function drawSideRuler() {
  if (state.viewMode !== 'side') return;
  const W = canvas.width, H = canvas.height;
  const rw = 48;
  const rx = W - rw - 2;
  const ry = 10, rh = H - 20;

  ctx.fillStyle = 'rgba(4,10,14,0.82)';
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeStyle = '#1e4a2a'; ctx.lineWidth = 1;
  ctx.strokeRect(rx, ry, rw, rh);

  const rawStep = 50;
  const screenPixPerStep = rawStep * viewPX() * 0.9 * state.sideAltScale;
  const step = screenPixPerStep < 14 ? rawStep * Math.ceil(14/screenPixPerStep) : rawStep;

  ctx.font = 'bold 8px Share Tech Mono';
  for (let a = 0; a <= 3000; a += step) {
    const p = proj(0, 0, a);
    const sy = p.sy;
    if (sy < ry || sy > ry + rh) continue;
    const isMajor = a % 100 === 0;
    ctx.strokeStyle = isMajor ? '#3a8855' : '#1e4a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx, sy); ctx.lineTo(rx + (isMajor ? 10 : 5), sy);
    ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = a === 0 ? '#2a8844' : '#88ddaa';
      ctx.fillText(a + 'm', rx + 12, sy + 3);
    }
  }

  for (const d of state.drones) {
    if (!d.alive) continue;
    const p  = proj(0, 0, d.wz);
    const sy = Math.max(ry+2, Math.min(ry+rh-2, p.sy));
    ctx.fillStyle = d.type.color;
    ctx.shadowColor = d.type.color; ctx.shadowBlur = 5;
    ctx.beginPath(); ctx.arc(rx + rw - 8, sy, 3, 0, Math.PI*2); ctx.fill();
  }
  for (const intc of state.interceptors) {
    if (!intc.alive) continue;
    const p  = proj(0, 0, intc.wz);
    const sy = Math.max(ry+2, Math.min(ry+rh-2, p.sy));
    ctx.fillStyle = '#00ff88';
    ctx.shadowColor = '#00ff88'; ctx.shadowBlur = 5;
    ctx.beginPath(); ctx.arc(rx + rw - 8, sy, 2.5, 0, Math.PI*2); ctx.fill();
  }
  ctx.shadowBlur = 0;

  ctx.save();
  ctx.fillStyle = '#3a8855'; ctx.font = '7px Share Tech Mono';
  ctx.translate(rx + rw - 3, ry + rh * 0.5);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('ALT (m)', 0, 0);
  ctx.restore();
}

function drawAltStrip() {
  const W = canvas.width, H = canvas.height;
  const bx = W - 42, bt = 18, bh = H - 48;
  const maxAlt = 700;
  ctx.fillStyle = 'rgba(6,10,14,0.80)'; ctx.fillRect(bx-2, bt-2, 44, bh+4);
  ctx.strokeStyle = '#1e4a30'; ctx.lineWidth = 1; ctx.strokeRect(bx-2, bt-2, 44, bh+4);
  for (let a = 0; a <= maxAlt; a += 100) {
    const sy = bt + bh - (a/maxAlt)*bh;
    ctx.strokeStyle = '#2a6640'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(bx, sy); ctx.lineTo(bx+12, sy); ctx.stroke();
    ctx.shadowColor = '#00ff88'; ctx.shadowBlur = 4;
    ctx.fillStyle = a === 0 ? '#336644' : '#77ffaa'; ctx.font = 'bold 8px Share Tech Mono';
    ctx.fillText(a === 0 ? '0' : a + 'm', bx+14, sy+3);
    ctx.shadowBlur = 0;
  }
  for (const d of state.drones) {
    if (!d.alive) continue;
    const sy = bt + bh - Math.min(1, d.wz/maxAlt)*bh;
    ctx.fillStyle = d.type.color; ctx.shadowColor = d.type.color; ctx.shadowBlur = 5;
    ctx.beginPath(); ctx.arc(bx+5, sy, 3.5, 0, Math.PI*2); ctx.fill();
  }
  for (const intc of state.interceptors) {
    if (!intc.alive) continue;
    const sy = bt + bh - Math.min(1, intc.wz/maxAlt)*bh;
    ctx.fillStyle = '#00ff88'; ctx.shadowColor = '#00ff88'; ctx.shadowBlur = 5;
    ctx.beginPath(); ctx.arc(bx+5, sy, 2.5, 0, Math.PI*2); ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.shadowColor = '#00ff88'; ctx.shadowBlur = 4;
  ctx.fillStyle = '#44bb77'; ctx.font = 'bold 7px Share Tech Mono';
  ctx.save(); ctx.translate(bx+40, bt+bh*0.5); ctx.rotate(-Math.PI/2); ctx.fillText('ALT(m)', 0, 0); ctx.restore();
  ctx.shadowBlur = 0;
}

// ── Main draw entry point ──
export function draw() {
  const W = canvas.width, H = canvas.height;
  if (state.viewMode === 'iso') {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#07111a');
    bgGrad.addColorStop(1, '#030810');
    ctx.fillStyle = bgGrad;
  } else {
    ctx.fillStyle = '#060a0e';
  }
  ctx.fillRect(0, 0, W, H);
  drawGrid();
  drawScaleSquare();
  const showTrails = document.getElementById('showTrails').value === '1';

  if (showTrails) {
    drawTrails(state.drones, d => d.type.color);
    drawTrails(state.interceptors, i => intcColor(i));
  }

  drawFullPaths();

  // Altitude drop-lines (non-top views)
  if (state.viewMode !== 'top') {
    for (const d of state.drones) {
      if (!d.alive) continue;
      const p = proj(d.wx, d.wy, d.wz), g = proj(d.wx, d.wy, 0);
      ctx.strokeStyle = d.type.color + '44'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(p.sx,p.sy); ctx.lineTo(g.sx,g.sy); ctx.stroke();
    }
    for (const intc of state.interceptors) {
      if (!intc.alive) continue;
      const p = proj(intc.wx, intc.wy, intc.wz), g = proj(intc.wx, intc.wy, 0);
      ctx.strokeStyle = 'rgba(0,255,136,0.2)'; ctx.lineWidth = 1; ctx.setLineDash([2,3]);
      ctx.beginPath(); ctx.moveTo(p.sx,p.sy); ctx.lineTo(g.sx,g.sy); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Explosions + frag zone rings
  for (const ex of state.explosions) {
    const p = proj(ex.wx, ex.wy, ex.wz);
    ctx.globalAlpha = ex.alpha * 0.85;
    const gr = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, worldR(ex.r)*0.7);
    gr.addColorStop(0, ex.color);
    gr.addColorStop(0.45, ex.color + '99');
    gr.addColorStop(1, 'transparent');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, worldR(ex.r)*0.7, 0, Math.PI*2); ctx.fill();
    if (ex.fragR && ex.fragR > 0 && ex.alpha < 0.6) {
      ctx.globalAlpha = ex.alpha * 0.5;
      ctx.strokeStyle = '#ffaa00';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(p.sx, p.sy, worldR(ex.fragR), 0, Math.PI*2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  // Impact icons
  if (document.getElementById('showImpactIcons').checked) {
    for (const c of state.craters) {
      const p = proj(c.wx, c.wy, c.wz || 0);
      const s = 5;
      ctx.save();
      if (c.type === 'kill') {
        ctx.strokeStyle = '#44dd77'; ctx.shadowColor = '#44dd77'; ctx.shadowBlur = 6; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.sx,   p.sy-s); ctx.lineTo(p.sx,   p.sy+s);
        ctx.moveTo(p.sx-s, p.sy);   ctx.lineTo(p.sx+s, p.sy);
        ctx.stroke();
        ctx.fillStyle = '#44dd77';
      } else {
        ctx.strokeStyle = '#666677'; ctx.shadowColor = '#666677'; ctx.shadowBlur = 3; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.sx-s, p.sy-s); ctx.lineTo(p.sx+s, p.sy+s);
        ctx.moveTo(p.sx+s, p.sy-s); ctx.lineTo(p.sx-s, p.sy+s);
        ctx.stroke();
        ctx.fillStyle = '#666677';
      }
      ctx.shadowBlur = 0;
      ctx.font = '7px Share Tech Mono';
      ctx.fillText(`I${c.id}`, p.sx+7, p.sy+3);
      ctx.restore();
    }
  }

  // Target
  if (state.target) {
    const p = proj(state.target.x, state.target.y, 0);
    if (state.viewMode === 'iso') {
      isoDrawTarget(state.target.x, state.target.y);
    } else {
      for (let ri = 0; ri < 4; ri++) {
        ctx.strokeStyle = `rgba(51,170,255,${0.18-ri*0.035})`;
        ctx.lineWidth = 1; ctx.beginPath();
        ctx.arc(p.sx, p.sy, worldR((ri+1)*22), 0, Math.PI*2); ctx.stroke();
      }
      ctx.fillStyle = '#33aaff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, 7, 0, Math.PI*2); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = '#33aaff'; ctx.font = '9px Share Tech Mono';
    ctx.fillText('TARGET', p.sx+10, p.sy-8);
  }

  // Launchers
  for (const l of state.launchers) {
    const p = proj(l.wx, l.wy, 0);
    if (state.viewMode === 'iso') {
      isoDrawLauncher(l.wx, l.wy);
    } else {
      ctx.fillStyle = '#aaaa00'; ctx.strokeStyle = '#dddd00'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(p.sx-7, p.sy-7, 14, 14); ctx.fill(); ctx.stroke();
      const elevR = parseInt(document.getElementById('launchElev').value) * Math.PI / 180;
      ctx.strokeStyle = '#dddd00'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(p.sx, p.sy);
      ctx.lineTo(p.sx, p.sy - 15*Math.sin(elevR + Math.PI*0.1)); ctx.stroke();
    }
    const lr = parseInt(document.getElementById('launchRange').value) * viewPX();
    if (state.viewMode !== 'iso') {
      ctx.strokeStyle = 'rgba(200,200,0,0.1)'; ctx.lineWidth = 1; ctx.setLineDash([5,5]);
      ctx.beginPath(); ctx.arc(p.sx, p.sy, lr, 0, Math.PI*2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = '#cccc00'; ctx.font = '8px Share Tech Mono';
    ctx.fillText('LAUNCHER', p.sx+11, p.sy+4);
  }

  // Drones
  for (const d of state.drones) {
    if (!d.alive) continue;
    const p = proj(d.wx, d.wy, d.wz);
    drawDrone(p.sx, p.sy, d);
    ctx.fillStyle = d.type.color; ctx.font = '9px Share Tech Mono';
    ctx.fillText(`T${d.id} ${Math.round(d.wz)}m`, p.sx+10, p.sy-6);
  }

  // Interceptors
  for (const intc of state.interceptors) {
    const isSelected = state.selectedIntcId !== null && intc.id === state.selectedIntcId;
    // Skip dead interceptors unless they are the selected one (show halo/path for terminated selection)
    if (!intc.alive && !isSelected) continue;
    const p = proj(intc.wx, intc.wy, intc.wz);

    if (state.selectedIntcId !== null && !isSelected) {
      ctx.globalAlpha = 0.2;
    } else {
      ctx.globalAlpha = 1.0;
    }

    if (isSelected) {
      // Pulsing cyan halo
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, 14, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,238,255,${0.15 + 0.1 * Math.sin(state.simTime * 4)})`;
      ctx.fill();
      // Historical telem path
      if (intc.telem.length >= 2) {
        ctx.save();
        ctx.strokeStyle = '#00eeff'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
        ctx.beginPath();
        const tp0 = proj(intc.telem[0].wx, intc.telem[0].wy, intc.telem[0].altitude);
        ctx.moveTo(tp0.sx, tp0.sy);
        for (let i = 1; i < intc.telem.length; i++) {
          const tpi = proj(intc.telem[i].wx, intc.telem[i].wy, intc.telem[i].altitude);
          ctx.lineTo(tpi.sx, tpi.sy);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    if (intc.alive) {
      drawInterceptor(p.sx, p.sy, intc);
      const lcol = intcColor(intc);
      ctx.fillStyle = lcol; ctx.font = '9px Share Tech Mono';
      ctx.fillText(`I${intc.id} ${Math.round(intc.wz)}m`, p.sx+9, p.sy-5);
      if (intc.target.alive) {
        const tp = proj(intc.target.wx, intc.target.wy, intc.target.wz);
        ctx.strokeStyle = 'rgba(0,255,136,0.12)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
        ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.lineTo(tp.sx, tp.sy); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (intc.fragOn) {
        const rc = intc.burnRemaining > 0 ? 'rgba(255,170,0,0.35)' : 'rgba(192,120,48,0.35)';
        ctx.strokeStyle = rc; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, worldR(intc.fragR), 0, Math.PI*2); ctx.stroke();
      }
    }

    ctx.globalAlpha = 1.0;
  }

  drawAltStrip();
  drawSideRuler();

  // View label
  ctx.fillStyle = 'rgba(0,255,136,0.25)'; ctx.font = '9px Orbitron,monospace';
  const vlx = state.viewMode === 'side' ? 48 : 10;
  ctx.fillText(
    state.viewMode === 'top' ? 'TOP (XY)' : state.viewMode === 'iso' ? 'ISOMETRIC (3D)' : 'SIDE (XZ)',
    vlx, H - 10
  );
}
