import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArenaServer } from '../server.mjs';

async function setup(t) {
  const app = createArenaServer({ dataDir: mkdtempSync(join(tmpdir(), 'quiet-http-')), engine: { choose: () => new Promise(() => {}) } });
  await app.listen(0);
  t.after(() => app.close());
  const root = `http://127.0.0.1:${app.port}`;
  const req = (path, role, body, extra = {}) => fetch(root + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(role ? { authorization: `Bearer ${app.tokens[role]}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, root, req };
}

test('player capability cannot read observer logs or change operator controls; evaluator/static engine refused', async t => {
  const { req } = await setup(t);
  assert.equal((await req('/api/player/state')).status, 401);
  assert.equal((await req('/api/player/state', 'player')).status, 200);
  for (const path of ['/api/observer/state', '/api/observer/export?format=json']) assert.equal((await req(path, 'player')).status, 403);
  for (const path of ['/api/observer/start', '/api/observer/reset', '/api/observer/review', '/api/observer/memory/import']) assert.equal((await req(path, 'player', {})).status, 403);
  for (const path of ['/api/player/hint', '/api/eval', '/api/hint', '/vendor/stockfish-18-lite-single.js', '/vendor/stockfish-18-lite-single.wasm', '/app.js', '/arena/arena.mjs', '/data/events.jsonl', '/.git/config']) assert.equal((await req(path, 'player')).status, 404);
  assert.equal((await req('/api/player/move', 'observer', {})).status, 403);
});

test('HTTP game flow, body/origin validation, and observer export', async t => {
  const { req, root } = await setup(t);
  const started = await (await req('/api/observer/start', 'observer', { player_color: 'w' })).json();
  assert.equal(started.state.phase, 'training');
  const s = (await (await req('/api/player/state', 'player')).json());
  const body = { request_id: crypto.randomUUID(), game_id: s.game_id, generation: s.generation, version: s.version, decision_id: s.decision_id, from: 'e2', to: 'e4' };
  assert.equal((await (await req('/api/player/move', 'player', body)).json()).ok, true);
  assert.equal((await (await req('/api/player/move', 'player', body)).json()).state.ply, 1);
  assert.equal((await req('/api/observer/start', 'observer', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await req('/api/observer/start', 'observer', {}, { origin: root })).status, 200);
  const exported = await req('/api/observer/export?format=pgn', 'observer');
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /e4/);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  const observer = await (await req('/api/observer/state', 'observer')).json();
  assert.ok(observer.events.some(e => e.type === 'move_accepted'));
  assert.equal(observer.diagnostic.counts.verified_memory_records, 0);
});
