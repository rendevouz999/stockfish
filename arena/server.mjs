import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Arena } from './arena.mjs';
import { StockfishEngine } from './engine.mjs';
import { openBrave } from './browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([
  ['/player', ['player.html', 'text/html; charset=utf-8']],
  ['/observer', ['observer.html', 'text/html; charset=utf-8']],
  ['/player.js', ['player.js', 'text/javascript; charset=utf-8']],
  ['/observer.js', ['observer.js', 'text/javascript; charset=utf-8']],
  ['/arena.css', ['arena.css', 'text/css; charset=utf-8']],
]);

export function createArenaServer({ dataDir = join(root, 'arena-data'), engine = new StockfishEngine() } = {}) {
  const arena = new Arena({ logPath: join(dataDir, 'events.jsonl'), engine });
  const tokens = { player: randomBytes(32).toString('base64url'), observer: randomBytes(32).toString('base64url') };
  const sameToken = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    try {
      const port = server.address()?.port;
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!allowedHosts.has(request.headers.host)) { json(response, 403, { ok: false, code: 'host_refused' }); return; }
      const origin = request.headers.origin;
      if (origin && ![...allowedHosts].some(host => origin === `http://${host}`)) { json(response, 403, { ok: false, code: 'origin_refused' }); return; }
      const url = new URL(request.url, `http://${request.headers.host}`);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/') {
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Quiet Chess Observation Arena\nUse the separate player and observer capability links printed in the server console.\n');
        return;
      }
      if (request.method === 'GET' && assets.has(path)) {
        const [name, type] = assets.get(path);
        const data = await readFile(join(publicDir, name));
        response.writeHead(200, { 'Content-Type': type }); response.end(data); return;
      }
      const routes = new Map([
        ['GET /api/player/state', 'player'], ['POST /api/player/move', 'player'],
        ['GET /api/observer/state', 'observer'], ['GET /api/observer/export', 'observer'],
        ['GET /api/observer/player-link', 'observer'],
        ['POST /api/observer/start', 'observer'], ['POST /api/observer/reset', 'observer'],
        ['POST /api/observer/review', 'observer'], ['POST /api/observer/memory/import', 'observer'],
      ]);
      const role = routes.get(`${request.method} ${path}`);
      if (!role) { json(response, 404, { ok: false, code: 'not_found' }); return; }
      const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : null;
      if (!sameToken(supplied, tokens[role])) {
        json(response, supplied ? 403 : 401, { ok: false, code: 'capability_required' }); return;
      }
      if (arena.closed) { json(response, 503, { ok: false, code: 'journal_unavailable' }); return; }
      let body;
      if (request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { json(response, 415, { ok: false, code: 'json_required' }); return; }
        let length = 0;
        const chunks = [];
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 1024 * 1024) { json(response, 413, { ok: false, code: 'body_too_large' }); return; }
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { json(response, 400, { ok: false, code: 'invalid_json' }); return; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { json(response, 400, { ok: false, code: 'object_required' }); return; }
      }
      if (path === '/api/player/state') json(response, 200, arena.playerState());
      else if (path === '/api/player/move') {
        const result = arena.move(body); json(response, result.ok ? 200 : 409, result);
      } else if (path === '/api/observer/state') json(response, 200, arena.observerState());
      else if (path === '/api/observer/player-link') json(response, 200, { player_url: '/player#token=' + tokens.player });
      else if (path === '/api/observer/start') json(response, 200, arena.start(body));
      else if (path === '/api/observer/reset') json(response, 200, arena.reset());
      else if (path === '/api/observer/review') json(response, 200, arena.review());
      else if (path === '/api/observer/memory/import') json(response, 200, arena.importMemory(body));
      else if (path === '/api/observer/export') {
        const format = url.searchParams.get('format') || 'json';
        const content = arena.export(format, url.searchParams.get('game_id'));
        response.writeHead(200, { 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="quiet-chess.${format}"` });
        response.end(content);
      }
    } catch (error) {
      if (!response.headersSent) json(response, arena.closed ? 503 : 400, { ok: false, code: arena.closed ? 'journal_unavailable' : 'invalid_request', error: String(error.message).slice(0, 400) });
      else response.destroy();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  return {
    arena, server, tokens,
    get port() { return server.address()?.port; },
    listen(port = 8124) {
      return new Promise((res, rej) => {
        const failed = error => { arena.close(); rej(error); };
        server.once('error', failed);
        server.listen(port, '127.0.0.1', () => { server.off('error', failed); res(); });
      });
    },
    close() {
      arena.close();
      return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let app;
  try {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required. Node.js 24 LTS is recommended.');
    let port = 8124;
    let dataDir = join(root, 'arena-data');
    let openBrowser = false;
    let browser = 'brave';
    let braveRoot = process.env.QUIET_CHESS_BRAVE_ROOT;
    for (let i = 2; i < process.argv.length; i++) {
      if (process.argv[i] === '--port') port = Number(process.argv[++i]);
      else if (process.argv[i] === '--data-dir') {
        const directory = process.argv[++i];
        if (!directory || directory.startsWith('--')) throw new Error('--data-dir requires an explicit directory');
        dataDir = resolve(directory);
      } else if (process.argv[i] === '--open') openBrowser = true;
      else if (process.argv[i] === '--browser') browser = process.argv[++i];
      else if (process.argv[i] === '--brave-root') braveRoot = process.argv[++i];
      else throw new Error(`Unknown argument: ${process.argv[i]}`);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
    if (browser !== 'brave') throw new Error('The supported auto-open browser is brave');
    if (openBrowser && !braveRoot) throw new Error('Specify --brave-root with your existing portable Brave folder, or use start-arena-brave.cmd');
    app = createArenaServer({ dataDir });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try { await app.close(); process.exit(0); }
      catch (error) { console.error(`Arena could not stop cleanly: ${error.message}`); process.exit(1); }
    };
    // Windows console close emits SIGHUP; Ctrl+Break emits SIGBREAK.
    // Forced termination/power loss can still leave a lock and must never trigger automatic removal.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, stop);
    await app.listen(port);
    console.log(`\nQuiet Chess Observation Arena — local-only\nPlayer:   http://127.0.0.1:${port}/player#token=${app.tokens.player}\nObserver: http://127.0.0.1:${port}/observer#token=${app.tokens.observer}\n\nKeep the observer link and this console private from the player controller.\nJournal: ${dataDir}\nNo live Memory integration is installed. Imports remain unverified.\nCtrl+C stops the server.\n`);
    if (openBrowser) {
      try {
        await openBrave({ browser, braveRoot, playerUrl: `http://127.0.0.1:${port}/player#token=${app.tokens.player}`, observerUrl: `http://127.0.0.1:${port}/observer#token=${app.tokens.observer}` });
        console.log('Portable Brave launch requested with player and observer tabs. Keep the observer tab outside the player controller.');
      } catch (error) { console.error(`Browser was not opened automatically: ${error.message}\nThe arena server is still running; use the printed links manually.`); }
    }
  } catch (error) {
    console.error(`Arena could not start: ${error.message}`);
    if (error.code === 'JOURNAL_LOCK_EXISTS') {
      let pid = 'unknown';
      try {
        const recorded = (await readFile(error.lockPath, 'utf8')).trim();
        if (/^[1-9][0-9]{0,9}$/.test(recorded)) pid = recorded;
      } catch { /* An unreadable or disappearing lock still must not be replaced. */ }
      console.error(`Lock: ${error.lockPath}\nRecorded PID: ${pid} (ownership is not verified).\nIf this arena is already running, use its existing console and tabs; Ctrl+C in that console stops it safely.\nOtherwise verify no arena uses this exact data directory, preserve the journal and lock, then rename only the confirmed stale lock before restarting once.\nNever remove an unknown/live lock or events.jsonl. See arena/README.md.`);
    }
    if (app) {
      try { await app.close(); }
      catch (closeError) { console.error(`Arena cleanup failed: ${closeError.message}`); }
    }
    process.exitCode = 1;
  }
}
