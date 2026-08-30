'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  ['web-client/js/webrtc.js', /\b(?:this\.|WebRTC\.)[A-Za-z_$][\w$]*/g],
  ['python-host/host.py', /\bself\.[A-Za-z_$][\w$]*/g],
  ['signal-server/websocket/signaling.js', /\bconnections\.(?:host|viewers|relayViewers)|\bhostCapabilities\b/g],
];

function scanFile(relativePath, matcher) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const counts = new Map();
  for (const match of source.matchAll(matcher)) {
    const token = match[0];
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 80);
}

function buildReport() {
  const lines = [
    '# Module State Owners',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'This is a static inventory. Counts identify likely mutable state owners; they are not runtime proof.',
    '',
  ];
  for (const [relativePath, matcher] of TARGETS) {
    lines.push(`## ${relativePath}`, '', '| Field | References |', '| --- | ---: |');
    for (const [token, count] of scanFile(relativePath, matcher)) lines.push(`| \`${token}\` | ${count} |`);
    lines.push('', '### Event/order notes', '', '- Facade methods and public event names remain compatibility boundaries.', '- Runtime verification must cover first frame, input, relay, lease transitions, and shutdown.', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function main(argv = process.argv.slice(2)) {
  const writeIndex = argv.indexOf('--write');
  if (writeIndex >= 0) {
    const output = argv[writeIndex + 1];
    if (!output) throw new Error('--write requires a path');
    const absolute = path.resolve(ROOT, output);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, buildReport(), 'utf8');
    return absolute;
  }
  process.stdout.write(buildReport());
  return null;
}

if (require.main === module) main();

module.exports = { buildReport, scanFile, main };
