'use strict';
// Root future private-build child only. Parent freezes/validates inputs and owns lifecycle.
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.length !== 4) throw new Error('exact fixture root and timestamp required');
const fixture = process.argv[2];
const builtAt = Number(process.argv[3]);
if (!path.isAbsolute(fixture) || !Number.isSafeInteger(builtAt) || builtAt < 0) throw new Error('invalid private build arguments');
if (!fs.lstatSync(fixture).isDirectory()) throw new Error('plain fixture directory required');
// Prediction pinned by root from old actual0644 assets; never modifies production umask.
process.umask(0o022);
const builder = require(path.join(fixture, 'signal-server/scripts/build-web-client.js'));
builder.buildWebClient({sourceDir: path.join(fixture, 'web-client'), outDir: path.join(fixture, 'web-client/dist'), now: () => builtAt})
  .then(() => { process.exitCode = 0; })
  .catch(() => { process.exitCode = 1; });
