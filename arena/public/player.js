'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  let token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);

  const pieces = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟', K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' };
  const pieceNames = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  const board = $('board');
  const promotionDialog = $('promotion-dialog');
  let state = null;
  let selected = null;
  let promotion = null;
  let pending = null;
  let sending = false;
  let sequence = 0;
  let appliedSequence = 0;
  let boardKey = '';
  let historyKey = '';

  function message(id, text, tone = '') {
    const element = $(id);
    element.textContent = text;
    element.className = `notice ${tone}`;
    element.hidden = !text;
  }

  function position(fen) {
    const result = {};
    const rows = (fen || '8/8/8/8/8/8/8/8').split(' ')[0].split('/');
    rows.forEach((row, index) => {
      let file = 0;
      for (const char of row) {
        if (/^[1-8]$/.test(char)) file += Number(char);
        else if (pieces[char] && file < 8 && index < 8) result[`${'abcdefgh'[file++]}${8 - index}`] = char;
      }
    });
    return result;
  }

  function turnKey(value) {
    return value ? `${value.game_id}|${value.generation}|${value.version}|${value.decision_id}|${value.phase}|${value.status}` : '';
  }

  function canMove() {
    return Boolean(token && state && state.status === 'active' && state.phase === 'training'
      && state.turn === state.player_color && !pending && !sending && state.legal_moves?.length);
  }

  function legalFrom(square) {
    return (state?.legal_moves || []).filter((move) => move.from === square);
  }

  function acceptState(next, requestSequence) {
    if (!next || typeof next !== 'object' || !Object.hasOwn(next, 'generation')) throw new Error('The server returned an invalid game state.');
    if (state) {
      const generation = Number(next.generation);
      const currentGeneration = Number(state.generation);
      if (generation < currentGeneration) return false;
      if (generation === currentGeneration) {
        if (Number(next.version) < Number(state.version)) return false;
        if (next.game_id !== state.game_id && requestSequence < appliedSequence) return false;
        if (Number(next.version) === Number(state.version) && requestSequence < appliedSequence) return false;
        // A duplicate move receipt can contain an older snapshot after review or an engine failure.
        if (Number(next.version) === Number(state.version)
          && ((state.phase === 'review' && next.phase === 'training')
          || (['ended', 'engine_error'].includes(state.status) && next.status === 'active'))) return false;
      } else if (!Number.isFinite(generation) && requestSequence < appliedSequence) return false;
    }
    const changed = turnKey(next) !== turnKey(state);
    state = next;
    appliedSequence = Math.max(appliedSequence, requestSequence);
    if (changed) {
      selected = null;
      promotion = null;
      if (promotionDialog.open) promotionDialog.close();
    }
    render();
    return true;
  }

  function renderBoard() {
    const key = `${state?.fen}|${state?.player_color}|${selected}|${canMove()}|${turnKey(state)}`;
    if (key === boardKey) return;
    boardKey = key;
    const positionMap = position(state?.fen);
    const black = state?.player_color === 'b';
    const files = [...(black ? 'hgfedcba' : 'abcdefgh')];
    const ranks = black ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    const focusedSquare = board.contains(document.activeElement) ? document.activeElement.dataset.square : null;
    const rememberedSquare = focusedSquare || board.querySelector('[tabindex="0"]')?.dataset.square;
    const focusSquare = rememberedSquare || (black ? 'h1' : 'a8');
    const fragment = document.createDocumentFragment();
    for (const [row, rank] of ranks.entries()) {
      for (const [column, file] of files.entries()) {
        const square = `${file}${rank}`;
        const piece = positionMap[square];
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.dataset.square = square;
        cell.className = `square ${(file.charCodeAt(0) - 97 + rank) % 2 === 1 ? 'dark' : ''}${selected === square ? ' selected' : ''}`;
        cell.tabIndex = square === focusSquare ? 0 : -1;
        const ownPiece = piece && (piece === piece.toUpperCase() ? 'w' : 'b') === state?.player_color;
        const legalDestination = selected && legalFrom(selected).some((move) => move.to === square);
        const selectable = canMove() && ((ownPiece && legalFrom(square).length > 0) || legalDestination);
        cell.setAttribute('aria-disabled', String(!selectable));
        cell.setAttribute('aria-pressed', String(selected === square));
        const description = piece ? `${piece === piece.toUpperCase() ? 'White' : 'Black'} ${pieceNames[piece.toLowerCase()]}` : 'empty';
        cell.setAttribute('aria-label', `${square}, ${description}${selected === square ? ', selected' : ''}`);
        if (piece) {
          const glyph = document.createElement('span');
          glyph.className = `piece${piece === piece.toUpperCase() ? ' white-piece' : ''}`;
          glyph.textContent = pieces[piece];
          glyph.setAttribute('aria-hidden', 'true');
          cell.append(glyph);
        }
        for (const [show, label, type] of [[column === 0, rank, 'rank'], [row === 7, file, 'file']]) {
          if (!show) continue;
          const coordinate = document.createElement('span');
          coordinate.className = `coordinate ${type}`;
          coordinate.textContent = label;
          coordinate.setAttribute('aria-hidden', 'true');
          cell.append(coordinate);
        }
        fragment.append(cell);
      }
    }
    board.replaceChildren(fragment);
    board.setAttribute('aria-label', `Chess board, ${black ? 'Black' : 'White'} at the bottom`);
    if (focusedSquare) board.querySelector(`[data-square="${focusedSquare}"]`)?.focus({ preventScroll: true });
  }

  function render() {
    let status = token ? 'Waiting for the operator to start a game.' : 'Player link required';
    if (state && token) {
      if (pending) status = sending ? 'Sending your move…' : 'Move receipt uncertain. Retry the same request below.';
      else if (state.status === 'engine_error') status = 'Engine interrupted. The operator can inspect the event log.';
      else if (state.status === 'ended') status = `Game ended${state.result ? ` · ${state.result}` : ''}${state.reason ? ` · ${state.reason}` : ''}`;
      else if (state.phase === 'review') status = 'Review mode. Player input is closed.';
      else if (state.status === 'active') status = canMove() ? (selected ? `${selected} selected. Choose a destination.` : 'Your turn.') : 'Waiting for the opponent…';
      $('color-label').textContent = state.player_color ? `You play ${state.player_color === 'b' ? 'Black' : 'White'}` : 'Waiting for a game';
      $('game-meta').textContent = state.game_id ? `Game ${state.game_id} · ${state.phase} · ply ${state.ply ?? 0}` : 'No active game';
    }
    if ($('status').textContent !== status) $('status').textContent = status;
    $('retry-move').hidden = !pending || !token;
    $('retry-move').disabled = sending;
    renderBoard();
    const moves = state?.moves || [];
    const nextHistoryKey = JSON.stringify(moves);
    if (historyKey !== nextHistoryKey) {
      historyKey = nextHistoryKey;
      const fragment = document.createDocumentFragment();
      moves.forEach((move, index) => {
        const item = document.createElement('li');
        const san = document.createElement('span');
        san.className = 'move-san';
        san.textContent = move.san || move.uci || '—';
        const meta = document.createElement('span');
        meta.className = 'caption';
        meta.textContent = `Ply ${index + 1} · ${move.actor === 'player' ? 'You' : move.actor === 'engine' ? 'Opponent' : move.actor || 'Recorded'}`;
        item.append(san, meta);
        fragment.append(item);
      });
      $('moves').replaceChildren(fragment);
      $('moves-empty').hidden = moves.length > 0;
      $('moves').scrollTop = $('moves').scrollHeight;
    }
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'omit', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
      if (response.status === 401 || response.status === 403) {
        token = null;
        throw new Error('Player access was rejected. Reopen the current player link supplied by the operator.');
      }
      const data = await response.json();
      return { response, data };
    } finally { clearTimeout(timeout); }
  }

  async function poll() {
    if (!token) return;
    const requestSequence = ++sequence;
    try {
      const { response, data } = await request('/api/player/state');
      if (!response.ok) throw new Error(`State request failed (${response.status}).`);
      acceptState(data, requestSequence);
      message('connection', '');
    } catch (error) {
      message('connection', token ? 'Connection interrupted. Showing the last received position; reconnecting…' : error.message, 'error');
      render();
    } finally {
      if (token) setTimeout(poll, 500);
    }
  }

  async function sendPending() {
    if (!pending || sending || !token) return;
    sending = true;
    message('action-message', '');
    render();
    const requestSequence = ++sequence;
    try {
      const { response, data } = await request('/api/player/move', { method: 'POST', body: pending.serialized });
      if (response.status >= 500 || typeof data.ok !== 'boolean') throw new Error('No definitive move receipt was received.');
      pending = null;
      selected = null;
      if (data.state) acceptState(data.state, requestSequence);
      if (!data.ok) message('action-message', `Move was not accepted: ${data.code || `HTTP ${response.status}`}. The latest position is shown.`, 'error');
      else message('action-message', '');
    } catch (error) {
      message('action-message', token
        ? 'The move may have reached the server. Retry uses the same request ID and move, so it cannot submit a second move.'
        : error.message, 'error');
    } finally {
      sending = false;
      render();
    }
  }

  function submitMove(move) {
    if (!canMove()) return;
    const body = { request_id: crypto.randomUUID(), game_id: state.game_id, generation: state.generation,
      version: state.version, decision_id: state.decision_id, from: move.from, to: move.to };
    if (move.promotion) body.promotion = move.promotion;
    pending = { serialized: JSON.stringify(body) };
    sendPending();
  }

  board.addEventListener('click', (event) => {
    const square = event.target.closest('[data-square]')?.dataset.square;
    if (!square || !canMove() || promotionDialog.open) return;
    if (square === selected) { selected = null; render(); return; }
    const candidates = selected ? legalFrom(selected).filter((move) => move.to === square) : [];
    if (candidates.length) {
      if (candidates.some((move) => move.promotion)) {
        promotion = { moves: candidates, key: turnKey(state) };
        for (const button of promotionDialog.querySelectorAll('[data-promotion]')) {
          button.disabled = !candidates.some((move) => move.promotion === button.dataset.promotion);
          const letter = state.player_color === 'b' ? button.dataset.promotion : button.dataset.promotion.toUpperCase();
          button.querySelector('.promotion-symbol').textContent = pieces[letter];
        }
        promotionDialog.showModal();
      } else submitMove(candidates[0]);
      return;
    }
    const piece = position(state.fen)[square];
    const color = piece && (piece === piece.toUpperCase() ? 'w' : 'b');
    selected = color === state.player_color && legalFrom(square).length ? square : null;
    render();
  });

  board.addEventListener('keydown', (event) => {
    const cells = [...board.querySelectorAll('[data-square]')];
    const index = cells.indexOf(event.target);
    if (index < 0) return;
    let target = index;
    if (event.key === 'ArrowLeft' && index % 8 > 0) target--;
    else if (event.key === 'ArrowRight' && index % 8 < 7) target++;
    else if (event.key === 'ArrowUp' && index >= 8) target -= 8;
    else if (event.key === 'ArrowDown' && index < 56) target += 8;
    else if (event.key === 'Home') target = index - index % 8;
    else if (event.key === 'End') target = index - index % 8 + 7;
    else if (event.key === 'Escape') { selected = null; render(); return; }
    else if (!event.key.startsWith('Arrow')) return;
    event.preventDefault();
    cells.forEach((cell, cellIndex) => { cell.tabIndex = cellIndex === target ? 0 : -1; });
    cells[target].focus();
  });

  promotionDialog.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-promotion]')?.dataset.promotion;
    if (!choice || !promotion || promotion.key !== turnKey(state)) return;
    const move = promotion.moves.find((candidate) => candidate.promotion === choice);
    if (!move) return;
    promotion = null;
    promotionDialog.close();
    submitMove(move);
  });
  $('cancel-promotion').addEventListener('click', () => promotionDialog.close());
  promotionDialog.addEventListener('close', () => { promotion = null; });
  $('retry-move').addEventListener('click', sendPending);

  render();
  if (token) poll();
  else message('connection', 'Open the original player URL containing #token=… to connect. The token is removed from the address bar and is not saved in browser storage.', 'error');
})();
