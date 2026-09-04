const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, 'viewer.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'viewer.html'), 'utf8');

test('status metrics reserve stable non-wrapping numeric slots', () => {
  assert.match(css, /\.status-metric[\s\S]*white-space:\s*nowrap/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.status-metrics[\s\S]*flex-wrap:\s*nowrap/);
  assert.match(css, /overflow:\s*hidden/);
  assert.match(css, /#fpsDisplay\s*\{[\s\S]*min-inline-size:/);
  assert.match(css, /#latencyDisplay\s*\{[\s\S]*inline-size:/);
  assert.match(css, /#candidateDisplay\s*\{[\s\S]*inline-size:/);
});

function getBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchor to a line-start rule so prefixed selectors like
  // `body.controls-hidden .network-advisor.visible` cannot steal the block.
  const pattern = new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const match = css.match(pattern);
  assert.ok(match, `missing CSS block for ${selector}`);
  return match[1];
}

test('terminal status sits in a named row above the workspace', () => {
  assert.match(css, /grid-template-areas/);
  assert.match(css, /terminal-workspace/);
  const htmlOrder = html.indexOf('id="terminalStatus"');
  const ws = html.indexOf('id="terminalWorkspace"');
  assert.ok(htmlOrder > -1 && ws > htmlOrder);
});

test('terminal composer describes its live submission hint', () => {
  assert.match(html, /id="terminalComposer"[\s\S]*?aria-describedby="terminalComposerHint"/);
  assert.match(html, /id="terminalComposerHint"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('network advisor supports right-edge auto-collapse tab', () => {
  assert.match(html, /id="networkAdvisor"[\s\S]*?id="networkAdvisorHandle"/);
  assert.match(html, /id="networkAdvisorHandleLabel"/);
  assert.match(html, /class="network-advisor__body"/);

  const collapsed = getBlock('.network-advisor.visible.collapsed');
  assert.match(collapsed, /width\s*:\s*44px/, 'collapsed advisor must shrink to a right-edge tab');
  assert.match(collapsed, /right\s*:\s*0/, 'collapsed advisor docks to the right edge');

  const visible = getBlock('.network-advisor.visible');
  assert.match(visible, /pointer-events\s*:\s*auto/, 'visible advisor must accept hover/click');
});

test('status bar groups metrics and actions for operator chrome', () => {
  assert.match(html, /class="status-metrics"/);
  assert.match(html, /class="status-actions"/);
  assert.match(html, /id="keyInputDisplay"[^>]*>键盘：未激活/);
  const metrics = getBlock('.status-metrics');
  assert.match(metrics, /inline-flex/);
});

test('toggle controls is a single status-bar button, not a separate fab', () => {
  assert.match(html, /id="toggleControlsBtn"/);
  assert.doesNotMatch(html, /id="showControlsBtn"/);
  assert.doesNotMatch(html, /id="showControlsFab"/);
  assert.match(css, /#toggleControlsBtn\s*\{/);
  assert.match(css, /body\.(controls-hidden|chrome-idle)\s+#toggleControlsBtn/);
});

test('tokens define chrome geometry and secondary text', () => {
  const tokens = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8');
  assert.match(tokens, /--chrome-top\s*:\s*56px/);
  assert.match(tokens, /--text-secondary\s*:\s*#cbd5e1/i);
  assert.match(tokens, /--touch-min\s*:\s*44px/);
  assert.match(tokens, /--focus-ring/);
});

test('hidden attribute cannot be overridden by flex buttons', () => {
  assert.match(css, /\[hidden\]\s*,\s*\.hidden\s*\{[^}]*display\s*:\s*none\s*!important/);
});

test('viewer css no longer redefines the :root token block', () => {
  assert.doesNotMatch(css, /:root\s*\{[^}]*--bg-primary/);
});

test('viewer layout uses --chrome-top instead of a hardcoded 56px body pad', () => {
  assert.match(css, /padding-top\s*:\s*var\(--chrome-top\)/);
  assert.doesNotMatch(css, /body\s*\{[^}]*padding-top\s*:\s*56px/);
});

test('viewer geometry has a dvh fallback and safe-area-aware dock', () => {
  assert.match(css, /height\s*:\s*calc\(100vh\s*-\s*var\(--chrome-top\)\)/);
  assert.match(css, /height\s*:\s*calc\(100dvh\s*-\s*var\(--chrome-top\)\)/);
  assert.match(css, /bottom:\s*calc\([^;]*env\(safe-area-inset-bottom/);
  assert.match(css, /\.chrome-docks[^}]*flex-direction:\s*column/);
});

test('mobile viewport geometry consumes the single keyboard bottom variable', () => {
  assert.match(css, /--mobile-keyboard-bottom/);
  assert.match(css, /bottom:\s*max\([^;]*var\(--mobile-keyboard-bottom/);
  assert.match(css, /padding-bottom:\s*max\([^;]*var\(--mobile-keyboard-bottom/);
});

test('mobile media geometry reserves dock and keyboard occupancy outside the remote surface', () => {
  assert.match(css, /--mobile-dock-height/);
  assert.match(css, /--mobile-text-dock-reserve\s*:/);
  const mobileViewer = css.match(/@media\s*\(max-width:\s*899px\)[\s\S]*?\.viewer-container\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(mobileViewer, /var\(--mobile-dock-height(?:,\s*0px)?\)/);
  assert.match(mobileViewer, /var\(--mobile-keyboard-bottom/);
  const mobileDocks = css.match(/@media\s*\(max-width:\s*899px\)[\s\S]*?\.chrome-docks\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(mobileDocks, /var\(--mobile-text-dock-reserve\)/);
  assert.match(mobileDocks, /var\(--mobile-keyboard-bottom/);
});

test('mobile media reserves the fixed Dock coordinate envelope', () => {
  const mobileViewer = css.match(/@media\s*\(max-width:\s*899px\)[\s\S]*?\.viewer-container\s*\{([^}]*)\}/)?.[1] || '';
  const completeDockEnvelope = /var\(--mobile-dock-height(?:,\s*0px)?\)\s*-\s*12px\s*-\s*env\(safe-area-inset-bottom,\s*0px\)\s*-\s*var\(--mobile-text-dock-reserve\)\s*-\s*var\(--mobile-keyboard-bottom,\s*0px\)/;
  assert.match(mobileViewer, completeDockEnvelope, 'remote surface must reserve the Dock height and its fixed bottom offset');
  assert.match(mobileViewer, /height\s*:\s*calc\(100vh/);
  assert.match(mobileViewer, /height\s*:\s*calc\(100dvh/);
});

test('narrow action row remains one line with stable touch widths', () => {
  assert.match(css, /@media\s*\(max-width:\s*899px\)[\s\S]*?\.action-bar[^{]*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /@media\s*\(max-width:\s*899px\)[\s\S]*?\.action-bar[^{]*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.action-bar\s+\.action-btn[^}]*min-width:\s*var\(--touch-min\)/);
});

test('mobile input reserves touch targets and keyboard safe area', () => {
  assert.match(html, /id="mobileTextInput"/);
  assert.match(html, /id="mobileTextInput"[^>]*inputmode="text"/);
  assert.match(html, /id="mobileInputDock"/);
  const textInput = getBlock('#mobileTextInput');
  const mobileDock = getBlock('#mobileInputDock');
  const mobileControls = getBlock('#mobileInputDock .control-btn');
  assert.match(textInput, /touch-action\s*:\s*none/);
  assert.match(mobileDock, /env\(safe-area-inset-bottom/);
  assert.match(mobileDock, /env\(keyboard-inset-height/);
  assert.match(mobileControls, /min-height\s*:\s*var\(--touch-min\)/);
});

test('mobile virtual key surface exposes accessible navigation, modifiers, shortcuts, and right click', () => {
  for (const action of ['escape', 'tab', 'backspace', 'enter', 'up', 'down', 'left', 'right', 'shift', 'ctrl', 'alt', 'meta', 'rightClick', 'copy', 'paste', 'cut', 'undo', 'selectAll', 'save', 'find', 'screenshot', 'switchInputMethod']) {
    assert.match(html, new RegExp(`data-mobile-action="${action}"`), `missing mobile ${action} button`);
  }
  assert.match(html, /id="mobileKeySurface"[^>]*aria-label="移动远程控制按键"/);
  assert.match(html, /data-mobile-action="shift"[^>]*aria-pressed="false"[^>]*aria-label="Shift"/);
  assert.match(html, /data-mobile-action="rightClick"[^>]*aria-label="右键点击"/);

  const keySurface = getBlock('#mobileKeySurface');
  const keyRow = getBlock('.mobile-key-row');
  const keyButtons = getBlock('#mobileKeySurface .mobile-key-btn');
  assert.match(keySurface, /env\(safe-area-inset-bottom/);
  assert.match(keySurface, /env\(keyboard-inset-height/);
  assert.match(keyRow, /overflow-x\s*:\s*auto/);
  assert.match(keyButtons, /min-width\s*:\s*var\(--touch-min\)/);
  assert.match(keyButtons, /min-height\s*:\s*var\(--touch-min\)/);
  assert.match(keyButtons, /touch-action\s*:\s*manipulation/);
  assert.match(keySurface, /pointer-events\s*:\s*auto/);
  assert.match(keyButtons, /pointer-events\s*:\s*auto/);
});

test('media surfaces suppress browser touch gestures', () => {
  const surfaces = getBlock('#remoteVideo,\n#relayImage');
  assert.match(surfaces, /touch-action\s*:\s*none/);
});

test('docks share one fixed column wrapper', () => {
  assert.match(html, /id="chromeDocks"[\s\S]*class="action-bar"[\s\S]*class="control-bar"/);
  const docks = getBlock('.chrome-docks');
  assert.match(docks, /position\s*:\s*fixed/);
  assert.match(docks, /flex-direction\s*:\s*column/);
  // getBlock() is a first-substring matcher; `.chrome-docks .control-bar {`
  // would steal `.control-bar`. Anchor to a line-start rule instead.
  assert.match(css, /(?:^|\n)\.action-bar\s*\{[^}]*display\s*:\s*flex/);
  assert.doesNotMatch(css, /(?:^|\n)\.action-bar\s*\{[^}]*position\s*:\s*fixed/);
  assert.match(css, /(?:^|\n)\.control-bar\s*\{[^}]*display\s*:\s*flex/);
  assert.doesNotMatch(css, /(?:^|\n)\.control-bar\s*\{[^}]*position\s*:\s*fixed/);
});

test('connected docks no longer use hover-only 0.22 opacity', () => {
  assert.doesNotMatch(css, /body\.stream-connected[^{]*\{[^}]*opacity\s*:\s*0\.22/);
});

test('narrow overflow menu exists', () => {
  assert.match(html, /id="moreActionsBtn"/);
  assert.match(html, /id="moreActionsMenu"/);
  assert.match(css, /min-height\s*:\s*var\(--touch-min\)/);
  assert.match(html, /data-action="enter"[^>]*data-pin="always"/);
  assert.match(html, /id="keyboardModeBtn"[^>]*data-pin="always"/);
  assert.match(html, /id="portSearchBtn"[^>]*class="control-btn"/);
  assert.match(css, /#moreActionsMenu\s+\.action-btn\s*\{[^}]*display\s*:\s*flex/);
  assert.match(css, /@media\s*\(max-width:\s*899px\)/);
});

test('narrow advisor cannot stretch to half the viewport', () => {
  assert.match(css, /max-height\s*:\s*min\(\s*240px,\s*40vh\s*\)/);
  assert.match(css, /align-items\s*:\s*flex-start/);
  const body = getBlock('.network-advisor.visible:not(.collapsed) .network-advisor__body');
  assert.match(body, /max-height\s*:\s*min\(\s*240px,\s*40vh\s*\)/, 'body must have a real max-height so overflow can scroll');
  assert.match(body, /min-height\s*:\s*0/);
  assert.match(body, /overflow-y\s*:\s*auto/);
});

test('placeholder spinner is opt-in via is-connecting', () => {
  assert.match(css, /\.stream-placeholder:not\(\.is-connecting\)\s+\.spinner/);
  assert.match(html, /id="exitFullscreenBtn"/);
});

test('workspace tabs expose tab semantics', () => {
  assert.match(html, /id="desktopTabBtn"[^>]*role="tab"[^>]*aria-controls="desktopPanel"/);
  assert.match(html, /id="terminalTabBtn"[^>]*role="tab"[^>]*aria-controls="terminalPanel"/);
  assert.match(html, /id="resolutionModal"[^>]*role="dialog"/);
  assert.match(html, /id="networkModal"[^>]*role="dialog"/);
  assert.match(html, /id="diagModal"[^>]*role="dialog"/);
  assert.doesNotMatch(html, /min-width:\s*600px/);
});
