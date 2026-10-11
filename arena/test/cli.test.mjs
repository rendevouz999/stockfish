import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const signalHarness = 'data:text/javascript,' + encodeURIComponent("process.on('message', ({signal, repeat = 1}) => { for (let i = 0; i < repeat; i++) process.emit(signal); }); process.channel?.unref();");
const temp = () => mkdtempSync(join(tmpdir(), 'quiet-cli-'));

async function launch(t, dataDir) {
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, ['--import', signalHarness, serverPath, '--port', String(port), '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close').then(([code, signal]) => ({ code, signal }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  const ready = async () => {
    const timeout = AbortSignal.timeout(5000);
    while (!stdout.includes('Ctrl+C stops the server.')) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Arena exited before becoming ready');
      await once(child.stdout, 'data', { signal: timeout });
    }
  };
  return { child, ready, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test('CLI refuses an active journal lock with path and PID guidance, preserving the owner', { timeout: 10000 }, async t => {
  const dir = temp();
  const owner = await launch(t, dir);
  await owner.ready();
  const logPath = join(dir, 'events.jsonl');
  const before = readFileSync(logPath, 'utf8');
  const contender = await launch(t, dir);
  assert.equal((await contender.closed).code, 1);
  assert.match(contender.stderr, /Arena could not start: Journal lock already exists/);
  assert.ok(contender.stderr.includes(logPath + '.lock'));
  assert.match(contender.stderr, new RegExp(`Recorded PID: ${owner.child.pid}\\b`));
  assert.doesNotMatch(contender.stderr, /at new Arena|file:\/\/|#token=/);
  assert.equal(readFileSync(logPath, 'utf8'), before);
  assert.equal(readFileSync(logPath + '.lock', 'utf8').trim(), String(owner.child.pid));
  assert.equal(owner.child.exitCode, null);
});

test('CLI leaves an unknown existing lock and journal untouched', { timeout: 10000 }, async t => {
  const dir = temp();
  const lockPath = join(dir, 'events.jsonl.lock');
  writeFileSync(lockPath, 'unknown owner\n');
  const app = await launch(t, dir);
  assert.equal((await app.closed).code, 1);
  assert.match(app.stderr, /Recorded PID: unknown/);
  assert.doesNotMatch(app.stderr, /at new Arena|#token=/);
  assert.equal(readFileSync(lockPath, 'utf8'), 'unknown owner\n');
  assert.equal(existsSync(join(dir, 'events.jsonl')), false);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  test(`CLI ${signal} handler is idempotent and releases its lock for relaunch`, { timeout: 10000 }, async t => {
    const dir = temp();
    const first = await launch(t, dir);
    await first.ready();
    // Exercise registered JS handlers portably. This does not prove Windows console delivery.
    first.child.send({ signal, repeat: 2 });
    assert.deepEqual(await first.closed, { code: 0, signal: null });
    assert.equal(existsSync(join(dir, 'events.jsonl.lock')), false);
    const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    const second = await launch(t, dir);
    await second.ready();
    assert.ok(readFileSync(join(dir, 'events.jsonl'), 'utf8').startsWith(before));
    second.child.send({ signal: 'SIGINT' });
    assert.equal((await second.closed).code, 0);
    assert.equal(existsSync(join(dir, 'events.jsonl.lock')), false);
  });
}

test('actual POSIX SIGHUP releases the lock', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const dir = temp();
  const app = await launch(t, dir);
  await app.ready();
  app.child.kill('SIGHUP');
  assert.deepEqual(await app.closed, { code: 0, signal: null });
  assert.equal(existsSync(join(dir, 'events.jsonl.lock')), false);
});

test('failed initial PID write cleans up only the newly acquired lock', () => {
  const logPath = join(temp(), 'events.jsonl');
  const source = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {Arena} from ${JSON.stringify(new URL('../arena.mjs', import.meta.url).href)};
    fs.writeSync = () => { throw new Error('simulated PID write failure'); }; syncBuiltinESMExports();
    try { new Arena({logPath: process.argv[1], engine: {}}); process.exitCode = 2; }
    catch (error) { if (error.message !== 'simulated PID write failure') process.exitCode = 3; }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, logPath], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(existsSync(logPath + '.lock'), false);
  assert.equal(existsSync(logPath), false);
});

test('CLI rejects a missing data directory value instead of silently selecting a journal', () => {
  const result = spawnSync(process.execPath, [serverPath, '--data-dir', '--port', '8125'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Arena could not start: --data-dir requires an explicit directory/);
  assert.doesNotMatch(result.stderr, /file:\/\/|#token=/);
});
