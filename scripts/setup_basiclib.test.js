const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'setup_basiclib.sh');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('setup_basiclib.sh exists and installs a local skill into the Codex skill dir', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'setup_basiclib.sh should exist');

  const tempProjectDir = makeTempDir('wrd-skill-project-');
  const tempAgentsRoot = makeTempDir('wrd-agents-skills-');
  const skillDir = path.join(tempProjectDir, 'skills', 'demo-local-skill');

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: demo-local-skill',
      'description: Use when verifying local skill installation.',
      '---',
      '',
      '# Demo Local Skill',
      '',
      'Installed from a local project path.',
      '',
    ].join('\n'),
    'utf8'
  );

  const lockPath = path.join(tempProjectDir, 'skills-lock.json');
  fs.writeFileSync(
    lockPath,
    JSON.stringify(
      {
        skills: {
          'demo-local-skill': {
            source: 'local',
            path: 'skills/demo-local-skill',
          },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  execFileSync('bash', [scriptPath], {
    cwd: tempProjectDir,
    env: {
      ...process.env,
      PROJECT_DIR_OVERRIDE: tempProjectDir,
      SKILLS_LOCK_FILE: lockPath,
      AGENTS_SKILLS_ROOT: tempAgentsRoot,
    },
    stdio: 'pipe',
  });

  const cacheLink = path.join(tempAgentsRoot, 'demo-local-skill');

  assert.equal(fs.lstatSync(cacheLink).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(cacheLink), fs.realpathSync(skillDir));
});

test('setup_basiclib.sh rejects local skill entries that do not contain SKILL.md', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'setup_basiclib.sh should exist');

  const tempProjectDir = makeTempDir('wrd-skill-project-missing-');
  const tempAgentsRoot = makeTempDir('wrd-agents-skills-missing-');
  const brokenDir = path.join(tempProjectDir, 'skills', 'broken-skill');

  fs.mkdirSync(brokenDir, { recursive: true });

  const lockPath = path.join(tempProjectDir, 'skills-lock.json');
  fs.writeFileSync(
    lockPath,
    JSON.stringify(
      {
        skills: {
          'broken-skill': {
            source: 'local',
            path: 'skills/broken-skill',
          },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  assert.throws(
    () =>
      execFileSync('bash', [scriptPath], {
        cwd: tempProjectDir,
        env: {
          ...process.env,
          PROJECT_DIR_OVERRIDE: tempProjectDir,
          SKILLS_LOCK_FILE: lockPath,
          AGENTS_SKILLS_ROOT: tempAgentsRoot,
        },
        stdio: 'pipe',
      }),
    /SKILL\.md/i
  );
});
