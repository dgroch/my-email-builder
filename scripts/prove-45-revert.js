'use strict';
// Read-only git access; every temporary source substitution is restored in finally.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const root = path.join(__dirname, '..');
const out = path.join(root, 'render-out/eb45-fix');
const files = ['lib/render.js', 'lib/klaviyo.js', 'design-system/templates/heroes/hero-image-only.html'];
const fixed = new Map(files.map(f => [f, fs.readFileSync(path.join(root, f))]));
const old = new Map();
const report = {};
async function run(name, cmd, args) {
  const log = path.join(out, name + '.txt');
  const fd = fs.openSync(log, 'w');
  let r;
  try {
    r = await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', fd, fd] });
      child.on('error', reject);
      child.on('close', (status, signal) => resolve({ status, signal }));
    });
  } finally { fs.closeSync(fd); }
  r.output = fs.readFileSync(log, 'utf8');
  report[name] = { exitCode: r.status, signal: r.signal };
  return r;
}
async function main() {
fs.mkdirSync(out, { recursive: true });
for (const f of files) {
  const r = await run('baseline-source-' + path.basename(f), 'git', ['show', `575e1a48:${f}`]);
  assert.equal(r.status, 0, `Cannot read original ${f}`);
  old.set(f, Buffer.from(r.output));
}
try {
  for (const [f, data] of old) fs.writeFileSync(path.join(root, f), data);
  assert.equal((await run('baseline-assembly', process.execPath, ['test/helpers/45-assembly.js', path.join(out, 'before')])).status, 0);
  assert.equal((await run('revert-all', process.execPath, ['test/45-images-off.test.js'])).status, 1, 'Original source must fail');
} finally {
  for (const [f, data] of fixed) fs.writeFileSync(path.join(root, f), data);
}
// Independently prove that each fix closes its own failure.
for (const f of files) {
  try {
    fs.writeFileSync(path.join(root, f), old.get(f));
    assert.equal((await run('revert-' + path.basename(f), process.execPath, ['test/45-images-off.test.js'])).status, 1, `${f}: regression must fail`);
  } finally { fs.writeFileSync(path.join(root, f), fixed.get(f)); }
}
assert.equal((await run('fixed-tests', process.execPath, ['test/45-images-off.test.js'])).status, 0);
assert.equal((await run('fixed-assembly', process.execPath, ['test/helpers/45-assembly.js', path.join(out, 'after')])).status, 0);
for (const [f, data] of fixed) assert.ok(fs.readFileSync(path.join(root, f)).equals(data));
report.sourceRestored = true;
fs.writeFileSync(path.join(out, 'revert-proof.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

}
main().catch(e => { console.error(e); process.exitCode = 1; });
