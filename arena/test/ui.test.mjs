import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

// Exercise the actual page's state/submit logic without pretending this minimal DOM is a browser.
function pageLogic(name, options = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, hidden: true, open: false, handlers: {},
      addEventListener(type, callback) { this.handlers[type] = callback; },
      close() { this.open = false; }, showModal() { this.open = true; }, querySelectorAll() { return []; },
      focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; },
      removeAttribute(name) { delete this[name]; }, setAttribute(name, value) { this[name] = value; },
      reportValidity() { return true; },
    });
    return elements.get(id);
  };
  const history = [];
  const context = {
    document: { getElementById: element, querySelectorAll: () => ['start-game', 'restart-game', 'review-game', 'reset-game', 'import-memory'].map(element) },
    fetch: async () => { throw new Error('Test fetch was not supplied'); },
    window: { location: { hash: options.hash ?? '#token=test-token', pathname: `/${name}`, search: '', origin: 'http://127.0.0.1:8124' }, open: options.open || (() => null), confirm: options.confirm || (() => true) },
    history: { replaceState(...args) { history.push(args); context.window.location.hash = args[2].includes('#') ? args[2].slice(args[2].indexOf('#')) : ''; } },
    URL, URLSearchParams, crypto: webcrypto, setTimeout, clearTimeout, AbortController,
  };
  let source = readFileSync(new URL(`../public/${name}.js`, import.meta.url), 'utf8');
  if (name === 'player') {
    source = source.replace(/\n  render\(\);\n  if \(token\) poll\(\);[\s\S]*$/, '\n  render = () => {}; globalThis.harness = { acceptState, canMove, submitMove, sendPending, position, getPending:()=>pending, getToken:()=>token, setRequest:fn=>{request=fn;} };\n})();');
  } else {
    source = source.replace(/\n  renderBoard\(null\);[\s\S]*$/, '\n  const actualSetControls = setControls;\n  renderBoard = renderStatus = renderDiagnostic = renderGames = renderEvents = setControls = () => {}; globalThis.harness = {acceptSnapshot, utc, actualSetControls, requestOriginal:request, getToken:()=>token, loadPlayerLink:typeof loadPlayerLink === "function" ? loadPlayerLink : null, startGame:typeof startGame === "function" ? startGame : null, setRequest:fn=>{request=fn;}, setRefresh:fn=>{refresh=fn;}};\n})();');
  }
  runInNewContext(source, context);
  assert.ok(context.harness, 'page bootstrap must be recognized; update harness if it changes');
  return { logic: context.harness, history, element, location: context.window.location, setFetch(fn) { context.fetch = fn; } };
}
const active = { game_id: 'game-1', generation: 1, version: 0, decision_id: 'decision-1', phase: 'training', status: 'active', turn: 'w', player_color: 'w', fen: '8/8/8/8/8/8/4P3/8 w - - 0 1', ply: 0, moves: [], legal_moves: [{ from: 'e2', to: 'e4' }] };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('player state logic refuses stale receipts and retries the exact move once', async () => {
  const { logic, history } = pageLogic('player');
  assert.equal(history.length, 0);
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
  assert.equal(history.length, 0);
  assert.equal(logic.utc('2026-10-11T13:40:00.001Z'), '2026-10-11 13:40:00.001 UTC');
  assert.equal(logic.utc('invalid'), 'Invalid timestamp');
  assert.equal(logic.acceptSnapshot({ state: active }, 1), true);
  assert.equal(logic.acceptSnapshot({ state: { ...active, status: 'ended', phase: 'review' } }, 2), true);
  assert.equal(logic.acceptSnapshot({ state: active }, 3), false);
  assert.equal(logic.acceptSnapshot({ state: { ...active, generation: 0 } }, 20), false);
});


for (const role of ['player', 'observer']) {
  test(`${role} reload and skip navigation preserve only its original capability fragment`, () => {
    const first = pageLogic(role);
    assert.equal(first.location.hash, '#token=test-token');
    assert.equal(first.logic.getToken(), 'test-token');
    assert.equal(typeof first.element('skip-main').handlers.click, 'function');
    first.element('skip-main').handlers.click();
    assert.equal(first.element('main').focused, true);
    assert.equal(first.element('main').scrolled, true);
    assert.equal(first.location.hash, '#token=test-token');
    assert.equal(pageLogic(role, { hash: first.location.hash }).logic.getToken(), 'test-token');
    assert.equal(pageLogic(role, { hash: '' }).logic.getToken(), null);
    const html = readFileSync(new URL(`../public/${role}.html`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /href="#main"/);
    const js = readFileSync(new URL(`../public/${role}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie/);
  });
}

const playerLink = '/player#token=' + 'p'.repeat(43);
const ok = (data) => ({ ok: true, status: 200, json: async () => data });

async function connectObserver(page) {
  assert.equal(typeof page.logic.loadPlayerLink, 'function');
  page.logic.setRequest(async path => {
    assert.equal(path, '/api/observer/player-link');
    return ok({ player_url: playerLink });
  });
  await page.logic.loadPlayerLink();
}

test('observer exposes a player-only link with no opener and rejects unexpected URLs', async () => {
  const page = pageLogic('observer');
  await connectObserver(page);
  assert.equal(page.element('open-player').href, playerLink);
  assert.equal(page.element('open-player').hidden, false);
  const html = readFileSync(new URL('../public/observer.html', import.meta.url), 'utf8');
  assert.match(html, /id="open-player"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  page.logic.setRequest(async () => ok({ player_url: '/observer#token=wrong-role' }));
  await assert.rejects(page.logic.loadPlayerLink(), /Invalid player link/);
});

test('start reserves a no-opener player tab and navigates only after a confirmed start', async () => {
  const popup = { opener: {}, closed: false, location: { replace(url) { this.url = url; } }, close() { this.closed = true; } };
  const page = pageLogic('observer', { open: () => popup });
  await connectObserver(page);
  assert.equal(typeof page.logic.startGame, 'function');
  let requests = 0;
  page.logic.setRequest(async (path, options) => {
    assert.equal(path, '/api/observer/start');
    assert.equal(popup.opener, null);
    assert.equal(popup.location.url, undefined);
    assert.deepEqual(JSON.parse(options.body), { player_color: 'w' });
    requests++;
    return ok({ ok: true, state: active });
  });
  page.logic.setRefresh(async () => { throw new Error('State reload lost'); });
  await page.logic.startGame({ player_color: 'w' });
  assert.equal(requests, 1);
  assert.equal(popup.location.url, playerLink, 'confirmed start survives a later refresh failure');
});

test('popup blocking and uncertain start receipts never duplicate a start request', async () => {
  const page = pageLogic('observer');
  await connectObserver(page);
  let requests = 0;
  let release;
  page.logic.setRequest(() => { requests++; return new Promise(resolve => { release = resolve; }); });
  page.logic.setRefresh(async () => {});
  const first = page.logic.startGame({});
  await page.logic.startGame({});
  assert.equal(requests, 1);
  release(ok({ ok: true }));
  await first;
  assert.match(page.element('player-message').textContent, /Buka Player/);
  page.logic.setRequest(async () => { requests++; throw new Error('Receipt lost'); });
  await page.logic.startGame({});
  assert.equal(requests, 2);
  assert.match(page.element('action-message').textContent, /No definitive receipt/);
});

test('restart uses the recorded game settings and cancellation sends nothing', async () => {
  let confirm = false;
  const page = pageLogic('observer', { confirm: () => confirm });
  await connectObserver(page);
  const config = { player_color: 'b', skill_level: 3, movetime_ms: 100, initial_fen: active.fen, training_label: 'saved game' };
  page.logic.acceptSnapshot({ state: active, games: [{ game_id: active.game_id, config }] }, 1);
  assert.equal(typeof page.element('restart-game').handlers.click, 'function');
  const calls = [];
  page.logic.setRequest(async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return ok({ ok: true }); });
  page.logic.setRefresh(async () => {});
  await page.element('restart-game').handlers.click();
  assert.equal(calls.length, 0);
  confirm = true;
  await page.element('restart-game').handlers.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/observer/start');
  assert.deepEqual(calls[0].body, config);
});


test('production observer controls gate starts and same-settings restart on usable access', async () => {
  const page = pageLogic('observer');
  page.logic.actualSetControls();
  assert.equal(page.element('start-game').disabled, true);
  assert.equal(page.element('restart-game').disabled, true);
  page.logic.acceptSnapshot({ state: { ...active, game_id: null, status: 'idle' }, games: [] }, 1);
  await connectObserver(page);
  page.logic.actualSetControls();
  assert.equal(page.element('start-game').disabled, false);
  assert.equal(page.element('restart-game').disabled, true);
  page.logic.acceptSnapshot({ state: { ...active, generation: 2 }, games: [{ game_id: active.game_id, config: { player_color: 'w' } }] }, 2);
  page.logic.actualSetControls();
  assert.equal(page.element('restart-game').disabled, false);
  page.setFetch(async () => ({ status: 403 }));
  await assert.rejects(page.logic.requestOriginal('/api/observer/state'), /access was rejected/);
  assert.equal(page.element('open-player').hidden, true);
  assert.equal(page.element('open-player').href, undefined);
  page.logic.actualSetControls();
  assert.equal(page.element('start-game').disabled, true);
  assert.equal(page.element('restart-game').disabled, true);
});

test('an older in-flight link response cannot restore a link after authentication rejection', async () => {
  const page = pageLogic('observer');
  await connectObserver(page);
  let release;
  page.logic.setRequest(() => new Promise(resolve => { release = resolve; }));
  const loading = page.logic.loadPlayerLink();
  page.setFetch(async () => ({ status: 403 }));
  await assert.rejects(page.logic.requestOriginal('/api/observer/state'), /access was rejected/);
  release(ok({ player_url: playerLink }));
  await loading;
  assert.equal(page.element('open-player').hidden, true);
  assert.equal(page.element('open-player').href, undefined);
});

for (const receipt of [ok({}), { ok: true, status: 200, json: async () => ({ ok: false, code: 'invalid_config' }) }]) {
  test('an unconfirmed start closes its reserved player tab without navigating', async () => {
    const popup = { opener: {}, closed: false, location: { replace() { throw new Error('Must not navigate'); } }, close() { this.closed = true; } };
    const page = pageLogic('observer', { open: () => popup });
    await connectObserver(page);
    let requests = 0;
    page.logic.setRequest(async () => { requests++; return receipt; });
    await page.logic.startGame({});
    assert.equal(requests, 1);
    assert.equal(popup.closed, true);
  });
}
