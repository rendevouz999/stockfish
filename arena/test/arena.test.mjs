import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Arena, Chess } from '../arena.mjs';

const quietEngine = { choose: () => new Promise(() => {}) };
function fixture(engine = quietEngine) {
  const logPath = join(mkdtempSync(join(tmpdir(), 'quiet-arena-')), 'events.jsonl');
  return { arena: new Arena({ logPath, engine }), logPath };
}
function submit(arena, from = 'e2', to = 'e4', extra = {}) {
  const s = arena.playerState();
  return { request_id: crypto.randomUUID(), game_id: s.game_id, generation: s.generation, version: s.version, decision_id: s.decision_id, from, to, ...extra };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('legal player move changes server board once; exact duplicate returns original receipt', async () => {
  const { arena, logPath } = fixture();
  arena.start({ player_color: 'w' });
  const body = submit(arena);
  const first = arena.move(body);
  assert.equal(first.ok, true);
  assert.equal(first.state.ply, 1);
  assert.deepEqual(arena.move(body), first);
  assert.equal(arena.playerState().ply, 1);
  assert.equal(arena.events.filter(e => e.type === 'move_accepted').length, 1);
  assert.equal(arena.move({ ...body, to: 'e3' }).code, 'request_id_conflict');
  const events = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
  for (const type of ['game_started', 'position_ready', 'action_received', 'move_accepted']) assert.ok(events.some(e => e.type === type));
  const accepted = events.find(e => e.type === 'move_accepted');
  assert.equal(accepted.san, 'e4');
  assert.equal(accepted.uci, 'e2e4');
  assert.equal(accepted.actor, 'player');
  assert.ok(accepted.ready_to_action_ms >= 0);
  assert.notEqual(accepted.fen_before, accepted.fen_after);
  assert.match(accepted.timestamp_utc, /Z$/);
  arena.close();
});

test('illegal, wrong-side, stale version/decision/generation and out-of-turn actions reject without mutation', () => {
  const { arena } = fixture();
  arena.start({ player_color: 'w' });
  const initial = arena.playerState();
  assert.equal(arena.move(submit(arena, 'e2', 'e5')).code, 'illegal_move');
  assert.equal(arena.move(submit(arena, 'e7', 'e5')).code, 'illegal_move');
  for (const [key, value] of [['version', 99], ['generation', 99], ['decision_id', 'old'], ['game_id', 'other']]) {
    assert.equal(arena.move(submit(arena, 'e2', 'e4', { [key]: value })).code, 'stale_state');
  }
  assert.equal(arena.playerState().fen, initial.fen);
  arena.move(submit(arena));
  assert.equal(arena.move(submit(arena, 'e7', 'e5')).code, 'not_player_turn');
  assert.deepEqual(arena.playerState().legal_moves, []);
  arena.close();
});

test('promotion is explicit and validated; endgame automatically enters review', () => {
  const { arena } = fixture();
  arena.start({ player_color: 'w', initial_fen: '7k/P7/8/8/8/8/8/7K w - - 0 1' });
  assert.equal(arena.move(submit(arena, 'a7', 'a8')).code, 'promotion_required');
  assert.equal(arena.move(submit(arena, 'a7', 'a8', { promotion: 'k' })).code, 'invalid_promotion');
  assert.equal(arena.move(submit(arena, 'a7', 'a8', { promotion: 'n' })).ok, true);
  assert.equal(arena.playerState().result, '1/2-1/2');
  assert.equal(arena.playerState().phase, 'review');
  assert.equal(arena.move(submit(arena, 'h1', 'h2')).code, 'game_not_active');
  arena.close();
});

test('checkmate and stalemate start positions record actual results', () => {
  const { arena } = fixture();
  arena.start({ initial_fen: '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', player_color: 'b' });
  assert.equal(arena.playerState().result, '1-0');
  assert.equal(arena.playerState().reason, 'checkmate');
  arena.start({ initial_fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' });
  assert.equal(arena.playerState().reason, 'stalemate');
  arena.close();
});

test('reset invalidates a pending opponent result and all old state handles', async () => {
  let finish;
  const engine = { choose: () => new Promise(resolve => { finish = resolve; }) };
  const { arena } = fixture(engine);
  arena.start({ player_color: 'b' });
  await flush();
  const old = arena.playerState();
  arena.reset();
  arena.start({ player_color: 'w' });
  finish('e2e4');
  await flush();
  assert.equal(arena.playerState().ply, 0);
  assert.notEqual(arena.playerState().game_id, old.game_id);
  assert.ok(arena.events.some(e => e.type === 'engine_result_discarded'));
  arena.close();
});

test('engine legal result works; illegal engine result pauses without fallback player moves', async () => {
  const { arena } = fixture({ choose: async () => 'e2e4' });
  arena.start({ player_color: 'b' });
  await flush();
  assert.equal(arena.playerState().ply, 1);
  assert.equal(arena.playerState().turn, 'b');
  arena.start({ player_color: 'w', initial_fen: '8/8/8/8/8/4k3/7p/4K3 b - - 0 1' });
  await flush();
  assert.equal(arena.playerState().status, 'engine_error');
  assert.equal(arena.playerState().ply, 0);
  arena.close();
});

test('invalid operator config cannot replace a current game', () => {
  const { arena } = fixture();
  arena.start({});
  const before = arena.playerState();
  for (const config of [{ player_color: 'x' }, { skill_level: -1 }, { movetime_ms: 1 }, { initial_fen: 'bad' }]) {
    assert.throws(() => arena.start(config));
    assert.deepEqual(arena.playerState(), before);
  }
  arena.close();
});

test('durable log replays legal moves and idempotent receipts; restart interrupts live game', () => {
  const { arena, logPath } = fixture();
  arena.start({});
  const body = submit(arena);
  const receipt = arena.move(body);
  const fen = arena.playerState().fen;
  arena.close();
  const recovered = new Arena({ logPath, engine: quietEngine });
  assert.equal(recovered.playerState().fen, fen);
  assert.equal(recovered.playerState().phase, 'review');
  assert.equal(recovered.playerState().reason, 'server_restart');
  assert.deepEqual(recovered.move(body), receipt);
  assert.equal(recovered.games.size, 1);
  assert.match(recovered.export('pgn'), /1\. e4/);
  const exported = JSON.parse(recovered.export('json'));
  assert.ok(exported.events.length);
  assert.equal(JSON.parse(recovered.export('jsonl').trim().split('\n')[0]).seq, 1);
  recovered.close();
  appendFileSync(logPath, '{broken');
  assert.throws(() => new Arena({ logPath, engine: quietEngine }), /journal|log/i);
});

test('Memory imports require real linkage/provenance, stay unverified, and deduplicate', () => {
  const { arena } = fixture();
  arena.start({});
  const state = arena.playerState();
  const record = { event_id: 'source-1', game_id: state.game_id, decision_id: state.decision_id,
    kind: 'retrieval', occurred_at: new Date().toISOString(), retrieval_ids: ['memory-42'],
    source: { system: 'Agent Core Memory', export_id: 'manual-export-1' } };
  assert.equal(arena.importMemory({ schema_version: 1, events: [record] }).imported, 1);
  assert.equal(arena.importMemory({ schema_version: 1, events: [record] }).duplicates, 1);
  const event = arena.events.find(e => e.type === 'memory_imported');
  assert.equal(event.verification, 'imported_unverified');
  assert.deepEqual(event.memory.retrieval_ids, ['memory-42']);
  for (const bad of [{ ...record, event_id: 'bad', game_id: 'unknown' }, { ...record, event_id: 'bad', decision_id: 'unknown' }, { ...record, event_id: 'bad', source: {} }, { ...record, event_id: 'bad', verification: 'verified' }]) {
    assert.throws(() => arena.importMemory({ schema_version: 1, events: [bad] }));
  }
  assert.throws(() => arena.importMemory({ schema_version: 1, events: [{ ...record, event_id: 'lesson', kind: 'lesson_applied', lesson: { id: 'one' } }] }));
  assert.equal(arena.diagnostic().ready, false);
  assert.match(arena.diagnostic().summary, /evidence|diagnostic/i);
  arena.close();
});

test('diagnostic is based on five finished played games, not five empty resets', () => {
  const { arena } = fixture();
  for (let i = 0; i < 5; i++) { arena.start({}); arena.reset(); }
  assert.equal(arena.diagnostic().completed_games, 0);
  for (let i = 0; i < 5; i++) { arena.start({}); arena.move(submit(arena)); arena.review(); }
  assert.equal(arena.diagnostic().completed_games, 0);
  assert.equal(arena.diagnostic().ready, false);
  for (let i = 0; i < 5; i++) {
    arena.start({ initial_fen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1' });
    arena.move(submit(arena, 'f7', 'g7'));
  }
  assert.equal(arena.diagnostic().completed_games, 5);
  assert.equal(arena.diagnostic().ready, true);
  assert.ok(arena.diagnostic().limitations.length);
  arena.close();
});

test('Memory lesson versions are explicit strings or safe integers; optional metadata is validated too', () => {
  const { arena } = fixture(); arena.start({});
  const state = arena.playerState();
  const base = { event_id: 'test-lesson', game_id: state.game_id, decision_id: state.decision_id, kind: 'lesson_applied', occurred_at: new Date().toISOString(), source: { system: 'Memory', export_id: 'export' }, lesson: { id: 'lesson-a', version: 'v2', provenance: 'source-trace-9' } };
  for (const version of [{ major: 1 }, true, [], 1.5, Infinity, null, '']) {
    assert.throws(() => arena.importMemory({ schema_version: 1, events: [{ ...base, lesson: { ...base.lesson, version } }] }));
  }
  assert.throws(() => arena.importMemory({ schema_version: 1, events: [{ ...base, kind: 'retrieval', retrieval_ids: ['a'], lesson: {} }] }));
  assert.equal(arena.importMemory({ schema_version: 1, events: [base] }).imported, 1);
  arena.close();
});

test('invalid request IDs are observable rejected submissions without storing unsafe IDs', () => {
  const { arena } = fixture(); arena.start({});
  assert.equal(arena.move({ ...submit(arena), request_id: '<bad>\nvalue' }).code, 'invalid_request_id');
  assert.equal(arena.events.at(-1).type, 'move_rejected');
  assert.equal(arena.events.at(-1).reason, 'invalid_request_id');
  assert.equal(arena.events.at(-1).request_id, null);
  assert.equal(arena.playerState().ply, 0);
  arena.close();
});

test('diagnostic median averages two middle measured samples', () => {
  const { arena } = fixture();
  for (const sample of [10, 1000]) {
    arena.start({ initial_fen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1' });
    arena.move(submit(arena, 'f7', 'g7'));
    // Controlled timing samples for the aggregation test, not imported user telemetry.
    arena.events.findLast(event => event.type === 'move_accepted').ready_to_action_ms = sample;
  }
  assert.equal(arena.diagnostic().counts.median_ready_to_action_ms, 505);
  arena.close();
});

test('concurrent starters fail closed on a stale lock rather than deleting another writer lock', async () => {
  const { spawn } = await import('node:child_process');
  const { writeFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'quiet-lock-race-'));
  const logPath = join(dir, 'events.jsonl');
  const lockPath = `${logPath}.lock`;
  writeFileSync(lockPath, '2147483647\n');
  const code = `import {Arena} from ${JSON.stringify(new URL('../arena.mjs', import.meta.url).href)}; try { const arena = new Arena({logPath: process.argv[1], engine: {}}); arena.close(); process.exitCode=2; } catch(error) { if (!/lock/i.test(error.message)) process.exitCode=3; }`;
  const start = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, logPath], { stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => resolve(code));
  });
  const results = await Promise.all([start(), start()]);
  assert.deepEqual(results, [0, 0]);
  assert.equal(readFileSync(lockPath, 'utf8'), '2147483647\n');
  assert.equal(existsSync(logPath), false, 'neither rejected starter writes any journal');
});
