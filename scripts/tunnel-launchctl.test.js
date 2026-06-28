const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const launchdPath = path.join(__dirname, '..', 'launchd', 'com.webremotedesktop.tunnel.plist');
const helperPath = path.join(__dirname, 'lib-tunnel-launchctl.sh');
const startPath = path.join(__dirname, 'start-safe-wrd.sh');
const stopPath = path.join(__dirname, 'stop-safe-wrd.sh');
const rotatePath = path.join(__dirname, 'restart-safe-tunnel.sh');

test('tunnel launchagent plist exists and uses the repo tunnel label', () => {
  assert.equal(fs.existsSync(launchdPath), true, 'tunnel launchagent plist should exist');
  const source = fs.readFileSync(launchdPath, 'utf8');

  assert.match(source, /com\.webremotedesktop\.tunnel/);
  assert.match(source, /run-safe-quicktunnel\.sh/);
  assert.match(source, /RunAtLoad/);
  assert.match(source, /KeepAlive/);
  assert.match(source, /wrd-safe-tunnel-supervisor\.log/);
});

test('tunnel launchctl helper exists and manages the tunnel launchagent label', () => {
  assert.equal(fs.existsSync(helperPath), true, 'tunnel launchctl helper should exist');
  const source = fs.readFileSync(helperPath, 'utf8');

  assert.match(source, /com\.webremotedesktop\.tunnel/);
  assert.match(source, /launchctl/);
  assert.match(source, /Library\/LaunchAgents/);
  assert.match(source, /wrd_tunnel_launchctl_rotate/);
  assert.match(source, /wrd-safe-current-url\.txt/);
  assert.match(source, /wrd-safe-current-url\.last\.txt/);
  assert.match(source, /wrd-safe-quicktunnel\.log/);
  assert.match(source, /pkill -f 'cloudflared\.\*tunnel\.\*--url http:\/\/127\\.0\\.0\\.1:8080'/);
  assert.match(source, /pkill -f 'run-safe-quicktunnel\\.sh'/);
});

test('tunnel rotate script exists and prints the published safe url', () => {
  assert.equal(fs.existsSync(rotatePath), true, 'rotate script should exist');
  const source = fs.readFileSync(rotatePath, 'utf8');

  assert.match(source, /Restarting safe tunnel \(rotate url\)/);
  assert.match(source, /safe url:/);
  assert.match(source, /wrd_tunnel_launchctl_rotate/);
});

test('safe startup script uses launchctl-backed tunnel lifecycle instead of nohup supervisor spawning', () => {
  const source = fs.readFileSync(startPath, 'utf8');

  assert.match(source, /lib-tunnel-launchctl\.sh/);
  assert.match(source, /wrd_tunnel_launchctl_start/);
  assert.match(source, /restart-safe-tunnel\.sh/);
  assert.doesNotMatch(source, /nohup "\$PROJECT_DIR\/scripts\/run-safe-quicktunnel\.sh"/);
});

test('safe stop script stops the tunnel through the shared launchctl helper', () => {
  const source = fs.readFileSync(stopPath, 'utf8');

  assert.match(source, /lib-tunnel-launchctl\.sh/);
  assert.match(source, /wrd_tunnel_launchctl_stop/);
});
