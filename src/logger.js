// logEvent: append timestamped entries to the on-screen event log panel.
import state from './state.js';

export function logEvent(msg, type = 'info') {
  const log = document.getElementById('eventLog');
  const d   = document.createElement('div');
  d.className = 'ev ' + type;
  d.textContent = `[${state.simTime.toFixed(1)}s] ${msg}`;
  log.insertBefore(d, log.firstChild);
  while (log.children.length > 40) log.removeChild(log.lastChild);
}
