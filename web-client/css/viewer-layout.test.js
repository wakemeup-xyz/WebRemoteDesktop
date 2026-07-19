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
