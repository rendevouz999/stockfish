import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

// Exercise the actual page's state/submit logic without pretending this minimal DOM is a browser.
function pageLogic(name) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, hidden: true, open: false, handlers: {},
      addEventListener(type, callback) { this.handlers[type] = callback; },
      close() { this.open = false; }, showModal() { this.open = true; }, querySelectorAll() { return []; },
    });
    return elements.get(id);
  };
  const history = [];
  const context = {
    document: { getElementById: element },
    window: { location: { hash: '#token=test-token', pathname: `/${name}`, search: '' } },
    history: { replaceState(...args) { history.push(args); } },
    URLSearchParams, crypto: webcrypto, setTimeout, clearTimeout, AbortController,
  };
  let source = readFileSync(new URL(`../public/${name}.js`, import.meta.url), 'utf8');
  if (name === 'player') {
    source = source.replace(/\n  render\(\);\n  if \(token\) poll\(\);[\s\S]*$/, '\n  render = () => {}; globalThis.harness = { acceptState, canMove, submitMove, sendPending, position, getPending:()=>pending, setRequest:fn=>{request=fn;} };\n})();');
  } else {
    source = source.replace(/\n  renderBoard\(null\);[\s\S]*$/, '\n  renderBoard = renderStatus = renderDiagnostic = renderGames = renderEvents = setControls = () => {}; globalThis.harness = {acceptSnapshot, utc};\n})();');
  }
  runInNewContext(source, context);
  assert.ok(context.harness, 'page bootstrap must be recognized; update harness if it changes');
  return { logic: context.harness, history };
}
const active = { game_id: 'game-1', generation: 1, version: 0, decision_id: 'decision-1', phase: 'training', status: 'active', turn: 'w', player_color: 'w', fen: '8/8/8/8/8/8/4P3/8 w - - 0 1', ply: 0, moves: [], legal_moves: [{ from: 'e2', to: 'e4' }] };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('player state logic refuses stale receipts and retries the exact move once', async () => {
  const { logic, history } = pageLogic('player');
  assert.equal(history[0][2], '/player');
  assert.equal(logic.position(active.fen).e2, 'P');
  assert.equal(logic.acceptState(active, 1), true);
  assert.equal(logic.canMove(), true);
  assert.equal(logic.acceptState({ ...active, generation: 0 }, 20), false);
  assert.equal(logic.acceptState({ ...active, version: 1 }, 2), true);
  assert.equal(logic.acceptState(active, 30), false);
  const review = { ...active, version: 1, status: 'ended', phase: 'review', decision_id: null, legal_moves: [] };
  assert.equal(logic.acceptState(review, 3), true);
  assert.equal(logic.acceptState({ ...active, version: 1 }, 2), false);
  assert.equal(logic.acceptState({ ...active, version: 1 }, 4), false, 'a later retry cannot resurrect an older cached state');
  assert.equal(logic.canMove(), false);
  assert.equal(logic.acceptState({ ...active, generation: 2, status: 'engine_error' }, 5), true);
  assert.equal(logic.acceptState({ ...active, generation: 2 }, 6), false);
  assert.equal(logic.acceptState({ ...active, generation: 3 }, 7), true);
  const calls = [];
  logic.setRequest(async (path, options) => {
    calls.push({ path, body: options.body });
    if (calls.length === 1) throw new Error('Simulated uncertain transport');
    return { response: { status: 200 }, data: { ok: true, state: { ...active, generation: 3, version: 1 } } };
  });
  logic.submitMove({ from: 'e2', to: 'e4' });
  await flush();
  assert.ok(logic.getPending());
  logic.submitMove({ from: 'e2', to: 'e4' });
  assert.equal(calls.length, 1);
  await logic.sendPending();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.ok(JSON.parse(calls[0].body).request_id);
  assert.equal(logic.getPending(), null);
  logic.acceptState({ ...active, generation: 4, legal_moves: [{ from: 'e7', to: 'e8', promotion: 'n' }] }, 10);
  let promotion;
  logic.setRequest(async (_, options) => {
    promotion = JSON.parse(options.body).promotion;
    return { response: { status: 200 }, data: { ok: true, state: { ...active, generation: 4, version: 1 } } };
  });
  logic.submitMove({ from: 'e7', to: 'e8', promotion: 'n' });
  await flush();
  assert.equal(promotion, 'n');
});

test('observer logic preserves terminal states and formats actual UTC timestamps', () => {
  const { logic, history } = pageLogic('observer');
  assert.equal(history[0][2], '/observer');
  assert.equal(logic.utc('2026-10-11T13:40:00.001Z'), '2026-10-11 13:40:00.001 UTC');
  assert.equal(logic.utc('invalid'), 'Invalid timestamp');
  assert.equal(logic.acceptSnapshot({ state: active }, 1), true);
  assert.equal(logic.acceptSnapshot({ state: { ...active, status: 'ended', phase: 'review' } }, 2), true);
  assert.equal(logic.acceptSnapshot({ state: active }, 3), false);
  assert.equal(logic.acceptSnapshot({ state: { ...active, generation: 0 } }, 20), false);
});
