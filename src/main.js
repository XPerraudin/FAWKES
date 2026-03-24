// Entry point: initialises UI, canvas, and renders the first frame.
import state, { canvas } from './state.js';
import { resize, draw, proj } from './renderer.js';
import { initUI, updateMotorCard, updateMapSizeDisplay, updateSideOverlay, updateScalesBtn } from './ui.js';
import { logEvent } from './logger.js';

// Set canvas to its real pixel dimensions before anything else reads them
resize();

// Place default target at field centre now that canvas dimensions are known
if (!state.target) {
  state.target = { x: state.mapFieldSize * 0.5, y: state.mapFieldSize * 0.5, z: 0 };
}

// Wire all DOM event listeners
initUI();

// Populate slider display values and motor card from default HTML values
updateMapSizeDisplay();
updateMotorCard();

// Sync view-dependent overlays with the default viewMode ('iso')
updateSideOverlay();
updateScalesBtn();

// Initial log messages (replicate original startup messages)
logEvent('Press ▶ START to begin', 'info');
logEvent('Switch to ISO or SIDE view to see altitude', 'info');
logEvent('LEFT-CLICK → move target', 'info');
logEvent('RIGHT-CLICK → place launcher', 'info');

// Render the initial empty battlefield
draw();

// Interceptor selection: click to select
canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  for (const intc of state.interceptors) {
    if (!intc.alive) continue;
    const { sx, sy } = proj(intc.wx, intc.wy, intc.wz);
    if (Math.hypot(cx - sx, cy - sy) < 18) {
      state.selectedIntcId = intc.id;
      break;
    }
  }
});
