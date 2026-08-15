const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'login.css'), 'utf8');

test('login form is labeled and announces errors', () => {
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /id="error"[^>]*role="alert"/);
  assert.match(html, /css\/tokens\.css/);
  assert.match(html, /密码错误/);
});

test('login css uses shared tokens and a visible focus ring', () => {
  assert.match(css, /var\(--accent-primary\)|--focus-ring|--bg-gradient-start/);
  assert.doesNotMatch(css, /outline:\s*none;\s*\n\s*border-color:/);
});
