// Entry point: initialises UI, canvas, and renders the first frame.
import state from './state.js';
import { resize, draw } from './renderer.js';
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
