// Sidebar controls, HUD updates, canvas input handlers, and all event listener wiring.
import { MOTORS, GRAVITY } from './constants.js';
import state, { canvas } from './state.js';
import { logEvent } from './logger.js';
import { draw, resize, screenToWorld } from './renderer.js';
// NOTE: circular import with simulation.js — safe because usage is in function bodies only
import {
  startSim, pauseSim, resetSim, endSim, openSweepModal,
  closeEndModal, closeSweepModal, startSweep, abortSweep,
  getAgilityParams, getLaunchMassG, getEffectiveDryMassG, getEffectiveTurnRate,
  sweepGetChecked,
} from './simulation.js';

// ── ISO reset button visibility ──
export function updateResetBtn() {
  const btn = document.getElementById('isoResetBtn');
  const rotated = Math.abs(state.isoAngle) > 0.01
               || Math.abs(state.isoPitch - 0.5) > 0.02
               || Math.abs(state.isoZoom - 1) > 0.01;
  btn.style.display = (state.viewMode === 'iso' && rotated) ? 'block' : 'none';
}

// ── Paths overlay button ──
export function updatePathsBtn() {
  const btn = document.getElementById('pathsToggleBtn');
  btn.style.display = state.simEnded ? 'block' : 'none';
  btn.textContent = state.showFullPaths ? 'PATHS: ON' : 'PATHS: OFF';
  btn.classList.toggle('off', !state.showFullPaths);
  updateKillsOnlyBtn();
}

// ── Scales button ──
export function updateScalesBtn() {
  const btn = document.getElementById('scalesToggleBtn');
  btn.style.display = state.viewMode === 'iso' ? 'block' : 'none';
  btn.textContent = state.showScales ? 'SCALES: ON' : 'SCALES: OFF';
  btn.classList.toggle('off', !state.showScales);
}

// ── Kills-only button ──
export function updateKillsOnlyBtn() {
  const btn = document.getElementById('killsOnlyBtn');
  btn.style.display = state.simEnded && state.showFullPaths ? 'block' : 'none';
  btn.classList.toggle('active', state.showKillsOnly);
  btn.textContent = state.showKillsOnly ? 'KILLS ONLY ✓' : 'KILLS ONLY';
}

// ── Side scale overlay visibility ──
export function updateSideOverlay() {
  const overlay = document.getElementById('sideScaleOverlay');
  overlay.style.display = (state.viewMode === 'side') ? 'flex' : 'none';
}

// ── Map size display and state update ──
export function updateMapSizeDisplay() {
  const v = parseInt(document.getElementById('mapSize').value);
  state.mapFieldSize = v;
  document.getElementById('vMapSize').textContent = v;
  document.getElementById('vMapPxScale').textContent = (1 / 0.5).toFixed(1);
  document.getElementById('vMapDiag').textContent = Math.round(v * Math.SQRT2);
  if (!state.running) {
    state.target = { x: v * 0.5, y: v * 0.5, z: 0 };
    state.launchers = [];
    draw();
  }
}

// ── Motor data card ──
export function updateMotorCard() {
  const m        = MOTORS[document.getElementById('motorType').value];
  const payloadG = parseInt(document.getElementById('payloadMass').value);
  const { g: agilG, cd } = getAgilityParams();
  const launchMassG = getLaunchMassG();
  const dryMassG    = getEffectiveDryMassG();
  const turnRate    = getEffectiveTurnRate();

  document.getElementById('ms_cls').textContent    = m.cls;
  document.getElementById('ms_thr').textContent    = m.avgThr.toFixed(0) + ' N';
  document.getElementById('ms_peak').textContent   = m.peakThr.toFixed(0) + ' N';
  document.getElementById('ms_burn').textContent   = m.burn.toFixed(1) + ' s';
  document.getElementById('ms_imp').textContent    = m.impulse.toLocaleString() + ' N·s';
  document.getElementById('ms_prop').textContent   = m.propMass + 'g';
  document.getElementById('ms_lmass').textContent  = launchMassG + 'g';
  document.getElementById('ms_cmass').textContent  = launchMassG + 'g';
  const initTW = m.peakThr / (launchMassG * 0.001 * GRAVITY);
  document.getElementById('ms_tw').textContent     = initTW.toFixed(1);
  document.getElementById('ms_cd').textContent     = cd.toFixed(2);
  document.getElementById('ms_drymass').textContent = dryMassG + 'g';

  document.getElementById('vPayload').textContent  = payloadG + 'g';
  document.getElementById('vTurnRate').textContent = 'turn: ' + turnRate + '°/s';
  document.getElementById('vAgility').textContent  = agilG + 'g';

  const warn = document.getElementById('vPassiveWarn');
  warn.style.display = agilG === 0 ? 'inline' : 'none';
}

// ── Header HUD + live stats panel ──
export function updateHUD() {
  const mm = Math.floor(state.simTime / 60).toString().padStart(2, '0');
  const ss = (state.simTime % 60).toFixed(1).padStart(4, '0');
  document.getElementById('hSimTime').textContent = mm + ':' + ss;
  document.getElementById('hThreats').textContent = state.totalSpawned;
  document.getElementById('hActive').textContent  = state.drones.filter(d => d.alive).length;
  document.getElementById('hFired').textContent   = state.totalFired;
  document.getElementById('hIntc').textContent    = state.interceptors.filter(i => i.alive).length;
  document.getElementById('hHits').textContent    = state.hitCount;
  document.getElementById('hKills').textContent   = state.killCount;
  const tot = state.hitCount + state.killCount;
  document.getElementById('hKillPct').textContent = tot > 0 ? Math.round(state.killCount / tot * 100) + '%' : '0%';

  document.getElementById('ls_t').textContent  = state.drones.filter(d => d.alive).length;
  document.getElementById('ls_i').textContent  = state.interceptors.filter(i => i.alive).length;
  document.getElementById('ls_kr').textContent = tot > 0 ? Math.round(state.killCount / tot * 100) + '%' : '0%';
  document.getElementById('ls_at').textContent = state.killTimes.length
    ? (state.killTimes.reduce((a, b) => a + b, 0) / state.killTimes.length).toFixed(1) + 's' : '-';
  document.getElementById('ls_cm').textContent = state.closestMiss < Infinity
    ? state.closestMiss.toFixed(1) + 'm' : '-';
  const mxAlt = state.drones.reduce((m, d) => d.alive ? Math.max(m, d.wz) : m, 0);
  document.getElementById('ls_ha').textContent = mxAlt > 0 ? Math.round(mxAlt) + 'm' : '-';
  document.getElementById('ls_ms').textContent = state.maxIntcSpd > 0
    ? Math.round(state.maxIntcSpd * 3.6) + ' km/h' : '-';

  // Live mass / T-W from most recently launched burning interceptor
  const burning  = state.interceptors.filter(i => i.alive && i.burnRemaining > 0);
  const liveIntc = burning.length ? burning[burning.length - 1]
                 : state.interceptors.filter(i => i.alive).pop();
  if (liveIntc) {
    document.getElementById('ms_cmass').textContent = Math.round(liveIntc.currentMassG) + 'g';
    const tw = liveIntc.currentThrust / (liveIntc.currentMassG * 0.001 * GRAVITY);
    document.getElementById('ms_tw').textContent = tw > 0 ? tw.toFixed(1) : '0.0 (coast)';
  } else if (!state.running || state.paused) {
    updateMotorCard();
  }
}

// ── Sweep: toggle all checkboxes in a group ──
export function sweepToggleAll(group) {
  const cbs = [...document.querySelectorAll(`input[data-group="${group}"]`)];
  const allChecked = cbs.every(cb => cb.checked);
  cbs.forEach(cb => cb.checked = !allChecked);
  const btn = document.querySelector(`.sw-toggle[data-group="${group}"]`);
  if (btn) btn.textContent = allChecked ? 'ALL' : 'NONE';
  updateSweepCounter();
}

// ── Sweep: recount total combinations ──
export function updateSweepCounter() {
  const drones    = sweepGetChecked('drone').length;
  const motors    = sweepGetChecked('motor').length;
  const lofts     = sweepGetChecked('loft').length;
  const ranges    = sweepGetChecked('range').length;
  const agilities = sweepGetChecked('agility').length;
  const fragrs    = sweepGetChecked('fragr').length;
  const seekmodes = sweepGetChecked('seekmode').length;
  const trajmodes = sweepGetChecked('trajmode').length;
  const payloads  = sweepGetChecked('payload').length;
  const salvos    = sweepGetChecked('salvo').length;
  const staggers  = sweepGetChecked('stagger').length;
  const batches   = sweepGetChecked('batchspread').length;
  const fragons   = sweepGetChecked('fragon').length;
  const combos = drones * motors * lofts * ranges
               * agilities * fragrs * seekmodes * trajmodes
               * payloads * salvos * staggers * batches * fragons;
  const dc = parseInt(document.getElementById('swDroneCount').value) || 10;
  const totalEng = combos * dc;
  document.getElementById('swComboCount').textContent       = combos;
  document.getElementById('swDroneCountDisplay').textContent = dc;
  document.getElementById('swTotalEngagements').textContent  = totalEng;
  const warn = document.getElementById('swLargeWarnLabel');
  if (warn) warn.style.display = totalEng > 50000 ? 'block' : 'none';
}

// ── Wire all event listeners — called once from main.js ──
export function initUI() {
  // Sim control buttons
  document.getElementById('btnStart').addEventListener('click', startSim);
  document.getElementById('btnPause').addEventListener('click', pauseSim);
  document.getElementById('btnReset').addEventListener('click', resetSim);
  document.getElementById('btnEnd').addEventListener('click', endSim);
  document.getElementById('btnSweep').addEventListener('click', openSweepModal);

  // Canvas overlay buttons
  document.getElementById('isoResetBtn').addEventListener('click', () => {
    state.isoAngle = 0; state.isoPitch = 0.5; state.isoZoom = 1;
    updateResetBtn(); draw();
  });
  document.getElementById('pathsToggleBtn').addEventListener('click', () => {
    state.showFullPaths = !state.showFullPaths; updatePathsBtn(); draw();
  });
  document.getElementById('scalesToggleBtn').addEventListener('click', () => {
    state.showScales = !state.showScales; updateScalesBtn(); draw();
  });
  document.getElementById('killsOnlyBtn').addEventListener('click', () => {
    state.showKillsOnly = !state.showKillsOnly; updateKillsOnlyBtn(); draw();
  });

  // End-sim modal buttons
  document.getElementById('endReviewBtn').addEventListener('click', closeEndModal);
  document.getElementById('endResetBtn').addEventListener('click', () => {
    closeEndModal(); resetSim();
  });

  // Sweep modal buttons
  document.getElementById('swCloseTitleBtn').addEventListener('click', closeSweepModal);
  document.getElementById('swRunBtn').addEventListener('click', startSweep);
  document.getElementById('swAbortBtn').addEventListener('click', abortSweep);
  document.getElementById('swCloseResultBtn').addEventListener('click', closeSweepModal);
  document.getElementById('swCopyJsonBtn').addEventListener('click', () => {
    const ta = document.getElementById('swJsonArea');
    ta.select();
    ta.setSelectionRange(0, 99999);
    try {
      document.execCommand('copy');
      const b = document.getElementById('swCopyJsonBtn');
      const orig = b.textContent;
      b.textContent = '✓ COPIED';
      setTimeout(() => b.textContent = orig, 1500);
    } catch (e) {
      alert('Select the text area and press Ctrl+C to copy.');
    }
    window.getSelection && window.getSelection().removeAllRanges();
  });

  // Sweep toggle-all buttons (wired via data-group on .sw-toggle class)
  document.querySelectorAll('.sw-toggle').forEach(btn => {
    btn.addEventListener('click', () => sweepToggleAll(btn.dataset.group));
  });

  // View toggle buttons
  ['vbTop', 'vbIso', 'vbSide'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => {
      state.viewMode = id === 'vbTop' ? 'top' : id === 'vbIso' ? 'iso' : 'side';
      ['vbTop', 'vbIso', 'vbSide'].forEach(x => document.getElementById(x).classList.remove('active'));
      document.getElementById(id).classList.add('active');
      updateResetBtn();
      updateScalesBtn();
      updateSideOverlay();
      draw();
    });
  });

  // Canvas: mouse + wheel
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('mousedown', e => {
    e.preventDefault();
    const r  = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (state.viewMode === 'iso' && state.running && e.button === 0) {
      state.isoDragging      = true;
      state.isoDragStartX    = mx;
      state.isoDragStartY    = my;
      state.isoDragStartAngle = state.isoAngle;
      state.isoDragStartPitch = state.isoPitch;
      document.body.classList.add('iso-dragging');
      return;
    }

    const { wx, wy } = screenToWorld(mx, my);
    if (e.button === 2) {
      state.launchers.push({ wx, wy, wz: 0, lastShot: -999 });
      logEvent(`Launcher at (${Math.round(wx)}m, ${Math.round(wy)}m)`, 'info');
    } else {
      state.target = { x: wx, y: wy, z: 0 };
      logEvent('Target repositioned', 'info');
    }
    if (!state.running) draw();
  });

  canvas.addEventListener('mousemove', e => {
    const r  = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (state.isoDragging) {
      const dyaw = (mx - state.isoDragStartX) / canvas.width * Math.PI * 2;
      state.isoAngle = state.isoDragStartAngle + dyaw;
      const dpitch = (my - state.isoDragStartY) / canvas.height * 1.5;
      state.isoPitch = Math.max(0.05, Math.min(1.0, state.isoDragStartPitch + dpitch));
      updateResetBtn();
      if (!state.running || state.paused) draw();
      return;
    }

    const { wx, wy } = screenToWorld(mx, my);
    document.getElementById('footCoords').textContent = `X:${Math.round(wx)}m  Y:${Math.round(wy)}m`;
  });

  canvas.addEventListener('mouseup', () => {
    state.isoDragging = false;
    document.body.classList.remove('iso-dragging');
  });
  canvas.addEventListener('mouseleave', () => {
    state.isoDragging = false;
    document.body.classList.remove('iso-dragging');
  });

  canvas.addEventListener('wheel', e => {
    if (state.viewMode !== 'iso') return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    state.isoZoom = Math.max(0.25, Math.min(6, state.isoZoom * factor));
    updateResetBtn();
    if (!state.running || state.paused) draw();
  }, { passive: false });

  // Tooltip
  (function () {
    const tip = document.getElementById('tip');
    let hideTimer;
    document.querySelector('.sidebar').addEventListener('mouseover', e => {
      const lbl = e.target.closest('label[data-tip]');
      if (!lbl) return;
      clearTimeout(hideTimer);
      tip.textContent = lbl.dataset.tip;
      tip.style.display = 'block';
    });
    document.querySelector('.sidebar').addEventListener('mousemove', e => {
      const lbl = e.target.closest('label[data-tip]');
      if (!lbl) return;
      const pad = 14, tw = 220;
      let lx = e.clientX + pad;
      if (lx + tw > window.innerWidth) lx = e.clientX - tw - pad;
      tip.style.left = lx + 'px';
      tip.style.top  = (e.clientY - 10) + 'px';
    });
    document.querySelector('.sidebar').addEventListener('mouseout', e => {
      const lbl = e.target.closest('label[data-tip]');
      if (!lbl) return;
      hideTimer = setTimeout(() => { tip.style.display = 'none'; }, 80);
    });
  }());

  // Sliders: generic bind-and-display helper
  function bs(id, vid, fmt) {
    const el = document.getElementById(id), vl = document.getElementById(vid);
    el.addEventListener('input', () => { vl.textContent = fmt(el.value); });
    vl.textContent = fmt(el.value);
  }
  bs('droneAlt',     'vDA',     v => v + 'm');
  bs('altVar',       'vAV',     v => v + 'm');
  bs('spawnCount',   'vSC',     v => v);
  bs('spawnInterval','vSI',     v => parseFloat(v).toFixed(1) + 's');
  bs('launchRange',  'vLR',     v => v + 'm');
  bs('launchElev',   'vLE',     v => v + '°');
  bs('loftAngle',    'vLoftA',  v => v + '°');
  bs('salvoSize',    'vSalvo',  v => v);
  bs('staggerInt',   'vStagger', v => parseFloat(v).toFixed(1) + 's');
  bs('batchSpread',  'vBS',     v => v + '°');
  bs('fragRadius',   'vFragR',  v => v + 'm');
  bs('simSpeed',     'vSS',     v => parseFloat(v).toFixed(1) + '×');

  // Map size slider
  document.getElementById('mapSize').addEventListener('input', updateMapSizeDisplay);

  // Side-view height scale slider
  document.getElementById('sideHeightScale2').addEventListener('input', e => {
    state.sideAltScale = parseFloat(e.target.value);
    document.getElementById('vSHS2').textContent = Math.round(state.sideAltScale) + '×';
    draw();
  });

  // Motor / agility / payload → update card
  document.getElementById('motorType').addEventListener('change', updateMotorCard);
  document.getElementById('payloadMass').addEventListener('input', updateMotorCard);
  document.getElementById('agilityG').addEventListener('input', updateMotorCard);

  // Window resize
  window.addEventListener('resize', () => { resize(); draw(); });
}
