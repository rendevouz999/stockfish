import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArenaServer } from '../server.mjs';

test('only an authenticated observer can obtain the existing player link', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'quiet-player-link-'));
  const app = createArenaServer({ dataDir, engine: { choose: () => new Promise(() => {}) } });
  await app.listen(0);
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${app.port}`;
  const get = (path, token, extra = {}) => fetch(root + path, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra } });
  const path = '/api/observer/player-link';
  assert.equal((await get(path)).status, 401);
  assert.equal((await get(path, app.tokens.player)).status, 403);
  assert.equal((await get(path, 'expired')).status, 403);
  assert.equal((await get(path, app.tokens.observer, { Origin: 'https://evil.example' })).status, 403);
  const response = await get(path, app.tokens.observer);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const link = await response.json();
  assert.deepEqual(link, { player_url: `/player#token=${app.tokens.player}` });
  assert.equal((await get('/api/player/state', app.tokens.observer)).status, 403);
  const state = await (await get('/api/player/state', app.tokens.player)).text();
  const observed = await (await get('/api/observer/state', app.tokens.observer)).text();
  const exported = await (await get('/api/observer/export?format=json', app.tokens.observer)).text();
  for (const body of [state, observed, exported]) {
    assert.ok(!body.includes(app.tokens.player));
    assert.ok(!body.includes(app.tokens.observer));
  }
});
