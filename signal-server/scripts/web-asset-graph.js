'use strict';

module.exports = Object.freeze({
  // Critical path only: enough for ShellGuard takeover, Start, signaling, media, input,
  // plus minimal diagnostic log capture so failure diagnosis remains possible.
  desktopScripts: Object.freeze([
    'js/runtime-config.js',
    'js/auth.js',
    'js/desktop-session-state.js',
    'js/webrtc-stats.js',
    'js/link-quality-controller.js',
    'js/media-activity-controller.js',
    'js/media-activity-lifecycle.js',
    'js/media-activity-runtime.js',
    'js/startup-telemetry.js',
    'js/bootstrap-controller.js',
    'js/terminal-loader.js',
    'js/diagnostic-core.js',
    'js/presentation-budget.js',
    'js/desktop-session-coordinator.js',
    'js/webrtc.js',
    'js/input-geometry.js',
    'js/keyboard-transport.js',
    'js/remote-keyboard-controller.js',
    'js/input.js',
    'js/chrome-layout.js',
    'js/ui.js',
  ]),
  // Loaded after core-interactive; must not block Start/signaling.
  // Heavy diagnostic panel attaches onto diagnostic-core; button stays disabled until ready.
  desktopDeferredScripts: Object.freeze([
    'js/stun-port-search-controller.js',
    'js/turn-selftest.js',
    'js/latency-monitor.js',
    'js/diagnostic.js',
  ]),
  terminalScripts: Object.freeze([
    'js/terminal-echo-controller.js',
    'js/terminal-composer.js',
    'js/terminal-input-gate.js',
    'js/terminal-turn-transport.js',
    'js/terminal-session-fsm.js',
    'js/terminal.js',
  ]),
});
