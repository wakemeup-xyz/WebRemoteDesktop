'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'runtime_reliability_acceptance_final.py');
const python = '/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3';

test('tunnel acceptance requires active phase, host ack, fresh relay frame, and bounded latency', () => {
  const result = childProcess.spawnSync(python, ['-c', [
    'import importlib.util',
    `s=importlib.util.spec_from_file_location('acceptance', ${JSON.stringify(scriptPath)})`,
    'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
    "assert not m.tunnel_resume_pass(True, 'resuming', True, True, 100)",
    "assert not m.tunnel_resume_pass(True, 'active', False, True, 100)",
    "assert not m.tunnel_resume_pass(True, 'active', True, False, 100)",
    "assert not m.tunnel_resume_pass(True, 'active', True, True, 2501)",
    "assert not m.tunnel_resume_pass(True, 'active', True, True, 100, False)",
    "assert m.tunnel_resume_pass(True, 'active', True, True, 2500, True)",
    "assert not m.captured_pointer_sequence([])",
    "assert not m.captured_pointer_sequence([1, 2, 1])",
    "assert m.captured_pointer_sequence([1, 1, 1])",
  ].join('; ')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('runtime harness uses pointer events and a sequenced dual-viewer flow', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /PointerEvent/);
  assert.match(source, /pointerId/);
  assert.match(source, /setPointerCapture/);
  assert.match(source, /auto_acquire=False/);
  assert.match(source, /A-get-control/);
  assert.match(source, /B-read-only/);
  assert.match(source, /B-takeover/);
  assert.match(source, /old_controller_local_write_rejected/);
  assert.match(source, /"PARTIAL"/);
});

test('acceptance isolates keyboard/mouse contexts and uses unified input readiness', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /def ensure_input_ready/);
  assert.match(source, /final-local-keyboard/);
  assert.match(source, /final-local-mouse/);
  assert.match(source, /syncDesktopInputGate/);
  assert.match(source, /r\.width \/ 2/);
});

test('acceptance login waits for Viewer DOM readiness rather than unrelated load completion', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /page\.wait_for_url\("\*\*\/viewer\.html\*\*", wait_until="domcontentloaded", timeout=45000\)/);
});

test('runtime report keeps an immutable timestamped artifact and a latest pointer', () => {
  const result = childProcess.spawnSync(python, ['-c', [
    'import importlib.util, pathlib, tempfile',
    `s=importlib.util.spec_from_file_location('acceptance', ${JSON.stringify(scriptPath)})`,
    'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
    "report={'timestamp':'2026-08-01T00:00:00Z','gates':{}}",
    'd=tempfile.TemporaryDirectory()',
    'written=m.write_report(report, pathlib.Path(d.name))',
    "assert pathlib.Path(written['artifact']).name == 'task9-final-report-2026-08-01T00-00-00Z.json'",
    "assert pathlib.Path(written['artifact']).exists()",
    "assert pathlib.Path(written['latest']).exists()",
    "assert len(written['sha256']) == 64",
    'written_again=m.write_report(report, pathlib.Path(d.name))',
    "assert written_again['artifact'] != written['artifact']",
    "assert pathlib.Path(written_again['artifact']).exists()",
  ].join('; ')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
