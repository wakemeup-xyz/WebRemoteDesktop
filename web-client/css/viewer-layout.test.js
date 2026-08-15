const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, 'viewer.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'viewer.html'), 'utf8');

function getBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const match = css.match(pattern);
  assert.ok(match, `missing CSS block for ${selector}`);
  return match[1];
}

test('terminal workspace is pinned to the final grid row', () => {
  const block = getBlock('.terminal-workspace');
  assert.match(block, /grid-row\s*:\s*5\b/, 'terminal workspace must occupy the final 1fr row');
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
