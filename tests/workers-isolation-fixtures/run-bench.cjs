'use strict';
// npm run test:bench:workers — runs the lag benchmark alone with FLEET_BENCH=1
// (absolute max-lag thresholds, design §11.3 / review N6). vitest runs from the
// directory that really holds node_modules (a git worktree reaches it through a
// junction) with --root pointing at this checkout, so both layouts work.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// realpathSync.native: canonical drive-letter case on Windows (a 'c:' vs 'C:' mismatch
// makes vitest load two instances of itself).
const root = fs.realpathSync.native(path.join(__dirname, '..', '..'));
const nm = fs.realpathSync.native(path.join(root, 'node_modules'));
const child = spawn(process.execPath, [path.join(nm, 'vitest', 'vitest.mjs'), 'run', '--root', root, 'workers-isolation-benchmark'],
  { cwd: path.dirname(nm), stdio: 'inherit', env: Object.assign({}, process.env, { FLEET_BENCH: '1' }) });
child.on('exit', (code) => process.exit(code == null ? 1 : code));
