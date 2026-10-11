import { readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// The original vendored ESM stays byte-for-byte intact despite the root CommonJS package.
const rules = readFileSync(new URL('../vendor/chess.js', import.meta.url));
export const { Chess, DEFAULT_POSITION } = await import(`data:text/javascript;base64,${rules.toString('base64')}`);
const clone = value => JSON.parse(JSON.stringify(value));
const mono = () => Number(process.hrtime.bigint()) / 1e6;
const validString = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function configFor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('config must be an object');
  const config = {
    player_color: input.player_color ?? 'w', skill_level: input.skill_level ?? 5,
    movetime_ms: input.movetime_ms ?? 300, initial_fen: input.initial_fen || DEFAULT_POSITION,
    training_label: input.training_label ?? '',
  };
  if (!['w', 'b'].includes(config.player_color)) throw new Error('player_color must be w or b');
  if (!Number.isInteger(config.skill_level) || config.skill_level < 0 || config.skill_level > 20) throw new Error('skill_level must be 0–20');
  if (!Number.isInteger(config.movetime_ms) || config.movetime_ms < 50 || config.movetime_ms > 2000) throw new Error('movetime_ms must be 50–2000');
  if (typeof config.initial_fen !== 'string' || config.initial_fen.length > 200) throw new Error('invalid initial_fen');
  if (typeof config.training_label !== 'string' || config.training_label.length > 200) throw new Error('training_label must be at most 200 characters');
  const chess = new Chess(config.initial_fen); // Authoritative validation before replacing any game.
  config.initial_fen = chess.fen();
  return config;
}

function outcome(chess) {
  if (chess.isCheckmate()) return { result: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
  if (chess.isStalemate()) return { result: '1/2-1/2', reason: 'stalemate' };
  if (chess.isThreefoldRepetition()) return { result: '1/2-1/2', reason: 'threefold_repetition' };
  if (chess.isInsufficientMaterial()) return { result: '1/2-1/2', reason: 'insufficient_material' };
  if (chess.isDrawByFiftyMoves()) return { result: '1/2-1/2', reason: 'fifty_move_rule' };
  return null;
}

export class Arena {
  constructor({ logPath, engine }) {
    this.engine = engine;
    this.logPath = logPath;
    this.lockPath = `${logPath}.lock`;
    this.events = [];
    this.games = new Map();
    this.requests = new Map();
    this.imports = new Map();
    this.generation = 0;
    this.current = null;
    this.sessionId = randomUUID();
    this.sessionStart = mono();
    this.closed = false;
    mkdirSync(dirname(logPath), { recursive: true });
    // Never unlink a pre-existing lock automatically: stale-lock recovery races with new writers.
    try { this.lockFd = openSync(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error('Journal lock already exists.'), { code: 'JOURNAL_LOCK_EXISTS', lockPath: this.lockPath });
      throw error;
    }
    try {
      writeSync(this.lockFd, `${process.pid}\n`);
      if (existsSync(logPath)) {
        const content = readFileSync(logPath, 'utf8');
        if (content && !content.endsWith('\n')) throw new Error('Journal has an incomplete final line; preserve and repair the log before restarting');
        for (const line of content.split('\n').filter(Boolean)) {
          let event;
          try { event = JSON.parse(line); } catch { throw new Error('Journal contains invalid JSON; no data was overwritten'); }
          this.restore(event);
          this.events.push(event);
        }
      }
      this.fd = openSync(logPath, 'a', 0o600);
      this.record('server_started', 'server', { previous_events: this.events.length });
      if (this.current?.phase === 'training') this.finish('*', 'server_restart');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  restore(event) {
    if (event.schema_version !== 1 || event.seq !== this.events.length + 1 || !validString(event.type)) throw new Error('Invalid journal event sequence or schema');
    this.generation = Math.max(this.generation, event.generation || 0);
    if (event.type === 'game_started') {
      if (this.games.has(event.game_id)) throw new Error('Duplicate game in journal');
      const config = configFor(event.config);
      const game = { game_id: event.game_id, generation: event.generation, version: 0, chess: new Chess(config.initial_fen), config, moves: [], phase: 'training', status: 'active', result: '*', reason: null, decision_id: null };
      this.games.set(event.game_id, game);
      this.current = game;
    } else if (event.type === 'move_accepted') {
      const game = this.games.get(event.game_id);
      if (!game || game.chess.fen() !== event.fen_before) throw new Error('Journal replay FEN mismatch before move');
      const move = game.chess.move({ from: event.uci?.slice(0, 2), to: event.uci?.slice(2, 4), ...(event.uci?.[4] ? { promotion: event.uci[4] } : {}) });
      if (!move || game.chess.fen() !== event.fen_after || move.san !== event.san) throw new Error('Journal replay FEN/SAN mismatch after move');
      game.moves.push({ san: move.san, uci: event.uci, actor: event.actor });
      game.version += 1;
    } else if (event.type === 'position_ready') {
      const game = this.games.get(event.game_id);
      if (!game) throw new Error('Journal ready event has no game');
      game.decision_id = event.decision_id;
    } else if (event.type === 'game_finished') {
      const game = this.games.get(event.game_id);
      if (!game) throw new Error('Journal finish event has no game');
      Object.assign(game, { phase: 'review', status: 'ended', result: event.result, reason: event.reason, decision_id: null });
    } else if (event.type === 'game_reset') {
      this.current = null;
    } else if (event.type === 'request_completed') {
      this.requests.set(event.request_id, { fingerprint: event.fingerprint, response: event.response });
    } else if (event.type === 'memory_imported') {
      this.imports.set(`${event.memory.source.system}\0${event.memory.source.export_id}\0${event.memory.event_id}`, JSON.stringify(event.memory));
    } else if (event.type === 'engine_error') {
      const game = this.games.get(event.game_id);
      if (game) game.status = 'engine_error';
    }
  }

  record(type, actor, data = {}, game = this.current) {
    if (this.closed) throw new Error('Arena is closed');
    const event = {
      schema_version: 1, seq: this.events.length + 1, event_id: randomUUID(), session_id: this.sessionId,
      type, timestamp_utc: new Date().toISOString(), monotonic_ms: mono() - this.sessionStart,
      game_id: game?.game_id ?? null, generation: game?.generation ?? this.generation,
      decision_id: game?.decision_id ?? null, ply: game?.moves.length ?? 0, actor,
      fen_before: game?.chess.fen() ?? null, fen_after: game?.chess.fen() ?? null,
      san: null, uci: null, ...data,
    };
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    // Sync append + fsync makes acknowledged events durable; a failed write fails closed.
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(this.fd, bytes, written, bytes.length - written);
      fsyncSync(this.fd);
    } catch (error) {
      this.closed = true;
      this.abort?.abort();
      throw new Error(`Journal write failed; stop the server and inspect storage: ${error.message}`);
    }
    this.events.push(event);
    return event;
  }

  start(input = {}) {
    const config = configFor(input);
    this.abort?.abort();
    if (this.current?.phase === 'training') this.finish('*', 'operator_replaced');
    const game = { game_id: randomUUID(), generation: ++this.generation, version: 0, chess: new Chess(config.initial_fen), config, moves: [], phase: 'training', status: 'active', result: '*', reason: null, decision_id: null };
    this.current = game;
    this.games.set(game.game_id, game);
    this.record('game_started', 'operator', { config: clone(config) });
    const end = outcome(game.chess);
    if (end) this.finish(end.result, end.reason);
    else this.ready();
    return { ok: true, state: this.playerState() };
  }

  reset() {
    this.abort?.abort();
    if (this.current?.phase === 'training') this.finish('*', 'operator_reset');
    ++this.generation;
    this.record('game_reset', 'operator', { generation: this.generation });
    this.current = null;
    return { ok: true, state: this.playerState() };
  }

  review() {
    if (this.current?.phase === 'training') this.finish('*', 'operator_review');
    return { ok: true, state: this.playerState() };
  }

  finish(result, reason) {
    this.abort?.abort();
    const game = this.current;
    if (!game || game.phase === 'review') return;
    this.record('game_finished', reason.startsWith('operator') ? 'operator' : 'server', { result, reason });
    Object.assign(game, { result, reason, phase: 'review', status: 'ended', decision_id: null });
  }

  ready() {
    const game = this.current;
    game.decision_id = randomUUID();
    game.readyAt = mono();
    const actor = game.chess.turn() === game.config.player_color ? 'player' : 'engine';
    this.record('position_ready', actor, { version: game.version, turn: game.chess.turn() });
    if (actor === 'engine') queueMicrotask(() => this.runEngine(game, game.version, game.decision_id));
  }

  playerState() {
    const game = this.current;
    if (!game) return { game_id: null, generation: this.generation, version: 0, decision_id: null, phase: 'idle', status: 'idle', turn: null, player_color: null, fen: DEFAULT_POSITION, ply: 0, moves: [], legal_moves: [], result: '*', reason: null };
    const canMove = game.phase === 'training' && game.status === 'active' && game.chess.turn() === game.config.player_color;
    return {
      game_id: game.game_id, generation: game.generation, version: game.version, decision_id: game.decision_id,
      phase: game.phase, status: game.status, turn: game.chess.turn(), player_color: game.config.player_color,
      fen: game.chess.fen(), ply: game.moves.length, moves: clone(game.moves),
      legal_moves: canMove ? game.chess.moves({ verbose: true }).map(({ from, to, promotion }) => ({ from, to, ...(promotion ? { promotion } : {}) })) : [],
      result: game.result, reason: game.reason,
    };
  }

  move(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'invalid_request', state: this.playerState() };
    const requestId = body.request_id;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) {
      this.record('action_received', 'player', { request_id: null, invalid_request_id: true });
      this.record('move_rejected', 'player', { request_id: null, reason: 'invalid_request_id' });
      return { ok: false, code: 'invalid_request_id', state: this.playerState() };
    }
    const request = Object.fromEntries(['game_id', 'generation', 'version', 'decision_id', 'from', 'to', 'promotion'].filter(key => own(body, key)).map(key => [key, body[key]]));
    const fingerprint = JSON.stringify(request);
    const cached = this.requests.get(requestId);
    if (cached) {
      if (cached.fingerprint === fingerprint) return clone(cached.response);
      this.record('move_rejected', 'player', { request_id: requestId, reason: 'request_id_conflict' });
      return { ok: false, code: 'request_id_conflict', state: this.playerState() };
    }
    const receivedAt = mono();
    const game = this.current;
    this.record('action_received', 'player', { request_id: requestId, submitted: request });
    let code = null;
    let selected;
    if (!game || game.phase !== 'training' || game.status !== 'active') code = 'game_not_active';
    else if (request.game_id !== game.game_id || request.generation !== game.generation || request.version !== game.version || request.decision_id !== game.decision_id) code = 'stale_state';
    else if (game.chess.turn() !== game.config.player_color) code = 'not_player_turn';
    else if (typeof request.from !== 'string' || typeof request.to !== 'string' || !/^[a-h][1-8]$/.test(request.from) || !/^[a-h][1-8]$/.test(request.to)) code = 'invalid_square';
    else if (own(request, 'promotion') && !['q', 'r', 'b', 'n'].includes(request.promotion)) code = 'invalid_promotion';
    else {
      const candidates = game.chess.moves({ verbose: true }).filter(move => move.from === request.from && move.to === request.to);
      if (!request.promotion && candidates.some(move => move.promotion)) code = 'promotion_required';
      else {
        selected = candidates.find(move => (move.promotion || undefined) === request.promotion);
        if (!selected) code = 'illegal_move';
      }
    }
    if (code) this.record('move_rejected', 'player', { request_id: requestId, reason: code, submitted: request, action_to_validation_ms: mono() - receivedAt });
    else this.accept(selected, 'player', { request_id: requestId, ready_to_action_ms: receivedAt - game.readyAt, action_to_accept_ms: mono() - receivedAt });
    const response = { ok: !code, code: code || 'move_accepted', state: this.playerState() };
    this.record('request_completed', 'player', { request_id: requestId, fingerprint, response: clone(response) }, game);
    this.requests.set(requestId, { fingerprint, response: clone(response) });
    return response;
  }

  accept(selected, actor, timing) {
    const game = this.current;
    const before = game.chess.fen();
    const decisionId = game.decision_id;
    const move = game.chess.move({ from: selected.from, to: selected.to, ...(selected.promotion ? { promotion: selected.promotion } : {}) });
    const uci = move.from + move.to + (move.promotion || '');
    game.moves.push({ san: move.san, uci, actor });
    game.version += 1;
    this.record('move_accepted', actor, { decision_id: decisionId, fen_before: before, fen_after: game.chess.fen(), san: move.san, uci, version: game.version, ...timing });
    const end = outcome(game.chess);
    if (end) this.finish(end.result, end.reason);
    else this.ready();
  }

  async runEngine(game, version, decisionId) {
    if (this.closed || this.current !== game || game.version !== version || game.phase !== 'training') return;
    const controller = new AbortController();
    this.abort = controller;
    const startedAt = mono();
    this.record('engine_search_started', 'engine', { version, movetime_ms: game.config.movetime_ms, skill_level: game.config.skill_level });
    const isCurrent = () => !this.closed && this.current === game && game.version === version && game.decision_id === decisionId && game.phase === 'training' && game.status === 'active';
    try {
      const uci = await this.engine.choose({ fen: game.chess.fen(), initialFen: game.config.initial_fen, moves: game.moves.map(move => move.uci), skill_level: game.config.skill_level, movetime_ms: game.config.movetime_ms, signal: controller.signal });
      if (this.closed) return;
      if (!isCurrent()) { this.record('engine_result_discarded', 'server', { decision_id: decisionId, reason: 'stale_generation_or_position' }, game); return; }
      if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Engine returned invalid move notation');
      const selected = game.chess.moves({ verbose: true }).find(move => move.from + move.to + (move.promotion || '') === uci);
      if (!selected) throw new Error('Engine returned an illegal move');
      this.accept(selected, 'engine', { engine_wall_ms: mono() - startedAt });
    } catch (error) {
      if (this.closed) return;
      if (!isCurrent()) { this.record('engine_result_discarded', 'server', { decision_id: decisionId, reason: 'cancelled_or_stale' }, game); return; }
      this.record('engine_error', 'server', { reason: String(error.message).slice(0, 400), engine_wall_ms: mono() - startedAt });
      game.status = 'engine_error';
    }
  }

  importMemory(input) {
    if (!input || input.schema_version !== 1 || !Array.isArray(input.events) || input.events.length > 1000) throw new Error('Expected schema_version 1 and up to 1000 events');
    const normalized = input.events.map(record => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid Memory event');
      if (own(record, 'verification') || own(record, 'verified')) throw new Error('Imported events cannot assert verification');
      const game = this.games.get(record.game_id);
      if (!game) throw new Error('Memory game_id must match a recorded game');
      if (!validString(record.event_id) || !['retrieval', 'lesson_created', 'lesson_applied'].includes(record.kind)) throw new Error('Invalid Memory event ID or kind');
      if (!record.source || !validString(record.source.system) || !validString(record.source.export_id)) throw new Error('Memory source.system and source.export_id are required');
      if (typeof record.occurred_at !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(record.occurred_at) || !Number.isFinite(Date.parse(record.occurred_at))) throw new Error('Memory occurred_at must be an ISO timestamp with timezone');
      if (record.decision_id != null && !this.events.some(event => event.type === 'position_ready' && event.game_id === record.game_id && event.decision_id === record.decision_id)) throw new Error('Memory decision_id does not belong to this game');
      if (['retrieval', 'lesson_applied'].includes(record.kind) && !validString(record.decision_id)) throw new Error('Retrieval and applied lessons require a decision_id');
      if (record.kind === 'retrieval' && (!Array.isArray(record.retrieval_ids) || !record.retrieval_ids.length)) throw new Error('Retrieval requires retrieval_ids');
      if (record.retrieval_ids != null && (!Array.isArray(record.retrieval_ids) || record.retrieval_ids.length > 1000 || record.retrieval_ids.some(id => !validString(id)))) throw new Error('Invalid retrieval_ids');
      if (record.kind.startsWith('lesson_') || own(record, 'lesson')) {
        const lesson = record.lesson;
        const versionValid = typeof lesson?.version === 'string' ? validString(lesson.version) : Number.isSafeInteger(lesson?.version) && lesson.version >= 0;
        if (!lesson || typeof lesson !== 'object' || Array.isArray(lesson) || !validString(lesson.id) || !versionValid || !validString(lesson.provenance, 2000)) throw new Error('Lesson requires id, an explicit string or nonnegative integer version, and provenance');
      }
      if (record.details != null && (typeof record.details !== 'string' || record.details.length > 4000)) throw new Error('Memory details must be at most 4000 characters');
      const memory = { event_id: record.event_id, game_id: record.game_id, kind: record.kind, occurred_at: record.occurred_at, source: { system: record.source.system, export_id: record.source.export_id } };
      if (record.decision_id != null) memory.decision_id = record.decision_id;
      if (record.retrieval_ids) memory.retrieval_ids = [...record.retrieval_ids];
      if (record.lesson) memory.lesson = { id: record.lesson.id, version: String(record.lesson.version), provenance: record.lesson.provenance };
      if (record.details != null) memory.details = record.details;
      return memory;
    });
    // Validate the complete batch before appending any of it, including intra-batch conflicts.
    const pending = new Map(this.imports);
    const additions = [];
    let duplicates = 0;
    for (const memory of normalized) {
      const key = `${memory.source.system}\0${memory.source.export_id}\0${memory.event_id}`;
      const encoded = JSON.stringify(memory);
      if (pending.has(key)) {
        if (pending.get(key) !== encoded) throw new Error('Memory event ID conflicts with existing content');
        duplicates++;
      } else { pending.set(key, encoded); additions.push({ key, encoded, memory }); }
    }
    for (const { key, encoded, memory } of additions) {
      this.record('memory_imported', 'memory', { memory, decision_id: memory.decision_id ?? null, verification: 'imported_unverified', receipt_status: 'local_import_recorded', meaning: 'Receipt confirms this server imported the record, not that Memory ran or learned.' }, this.games.get(memory.game_id));
      this.imports.set(key, encoded);
    }
    return { ok: true, imported: additions.length, duplicates, verification: 'imported_unverified' };
  }

  gameSummaries() {
    return [...this.games.values()].map(game => ({ game_id: game.game_id, phase: game.phase, status: game.status, ply: game.moves.length, result: game.result, reason: game.reason, config: clone(game.config) }));
  }

  diagnostic() {
    const games = [...this.games.values()].filter(game => game.phase === 'review' && game.moves.some(move => move.actor === 'player') && ['1-0', '0-1', '1/2-1/2'].includes(game.result)).slice(-5);
    const ids = new Set(games.map(game => game.game_id));
    const events = this.events.filter(event => ids.has(event.game_id));
    const playerMoves = events.filter(event => event.type === 'move_accepted' && event.actor === 'player');
    const latencies = playerMoves.map(event => event.ready_to_action_ms).filter(Number.isFinite).sort((a, b) => a - b);
    const counts = {
      player_moves: playerMoves.length, rejected_actions: events.filter(event => event.type === 'move_rejected').length,
      imported_memory_records: events.filter(event => event.type === 'memory_imported').length,
      verified_memory_records: 0,
      median_ready_to_action_ms: latencies.length ? (latencies[Math.floor((latencies.length - 1) / 2)] + latencies[Math.floor(latencies.length / 2)]) / 2 : null,
      decisive_games: games.filter(game => ['1-0', '0-1'].includes(game.result)).length,
      draws: games.filter(game => game.result === '1/2-1/2').length,
      operator_ended_games: [...this.games.values()].filter(game => game.reason === 'operator_review').length,
    };
    return {
      required_games: 5, completed_games: games.length, ready: games.length === 5, game_ids: [...ids], counts,
      summary: games.length === 5 ? 'Five-game diagnostic evidence is ready for human review. This is not an automatic verdict about learning.' : `${games.length}/5 played games with chess results available for the evidence diagnostic.`,
      limitations: [
        'Ready-to-action includes polling, rendering, controller, network, tool and thinking time; it is not pure reasoning latency.',
        'Only submitted actions are counted. Aborted clicks and locally suppressed illegal attempts are not observed.',
        'All Memory imports are unverified claims. A local receipt proves import only; no live Memory integration is installed.',
        'Five games do not establish learning or causation. Compare matched conditions and inspect retrieval relevance and lesson provenance.',
        'No evaluator was run, so blunder rate, centipawn loss and accuracy are not measured.',
      ],
    };
  }

  observerState() {
    return { state: this.playerState(), games: this.gameSummaries(), events: clone(this.events), diagnostic: this.diagnostic() };
  }

  export(format, gameId) {
    if (gameId && !this.games.has(gameId)) throw new Error('Unknown game_id');
    const events = gameId ? this.events.filter(event => event.game_id === gameId) : this.events;
    const games = [...this.games.values()].filter(game => !gameId || game.game_id === gameId);
    if (format === 'jsonl') return events.map(event => JSON.stringify(event)).join('\n') + '\n';
    if (format === 'json') return JSON.stringify({ schema_version: 1, exported_at: new Date().toISOString(), games: this.gameSummaries().filter(game => !gameId || game.game_id === gameId), events, diagnostic: this.diagnostic() }, null, 2);
    if (format === 'pgn') return games.map(game => {
      // Export from a fresh replay so headers never mutate the live game's rules state.
      const chess = new Chess(game.config.initial_fen);
      chess.header('Event', 'Quiet Chess Observation Arena', 'White', game.config.player_color === 'w' ? 'Player' : 'Stockfish 18', 'Black', game.config.player_color === 'b' ? 'Player' : 'Stockfish 18', 'Result', game.result, 'GameId', game.game_id, 'Termination', game.reason || 'unterminated');
      for (const move of game.moves) chess.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), ...(move.uci[4] ? { promotion: move.uci[4] } : {}) });
      return chess.pgn();
    }).join('\n\n') + '\n';
    throw new Error('format must be json, jsonl or pgn');
  }

  close() {
    this.closed = true;
    this.abort?.abort();
    if (this.fd != null) { closeSync(this.fd); this.fd = null; }
    if (this.lockFd != null) {
      closeSync(this.lockFd); this.lockFd = null;
      if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
    }
  }
}
