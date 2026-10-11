import test from 'node:test';
import assert from 'node:assert/strict';
import { StockfishEngine } from '../engine.mjs';
import { Chess, DEFAULT_POSITION } from '../arena.mjs';

test('bundled real Stockfish returns a legal move using Node and adjacent WASM', { timeout: 20000 }, async () => {
  const engine = new StockfishEngine();
  const move = await engine.choose({ fen: DEFAULT_POSITION, initialFen: DEFAULT_POSITION, moves: [], skill_level: 1, movetime_ms: 50 });
  assert.ok(new Chess().moves({ verbose: true }).some(m => m.from + m.to + (m.promotion || '') === move));
});

test('engine cancellation rejects without leaving a result to apply', async () => {
  const engine = new StockfishEngine();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.choose({ fen: DEFAULT_POSITION, initialFen: DEFAULT_POSITION, moves: [], skill_level: 1, movetime_ms: 50, signal: controller.signal }), /cancel/i);
});
