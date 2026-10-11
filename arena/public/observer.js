'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  let token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);

  const pieces = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟', K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' };
  let snapshot = null;
  let busy = false;
  let sequence = 0;
  let appliedSequence = 0;
  let boardKey = '';
  let eventsKey = '';
  let gamesKey = '';

  function message(id, text, tone = '') {
    const element = $(id);
    element.textContent = text;
    element.className = `notice ${tone}`;
    element.hidden = !text;
  }

  function textElement(tag, value, className = '') {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  }

  function readable(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  function utc(value) {
    if (!value) return 'Timestamp unavailable';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Invalid timestamp' : date.toISOString().replace('T', ' ').replace('Z', ' UTC');
  }

  function renderBoard(state) {
    const key = `${state?.fen}|${state?.player_color}`;
    if (key === boardKey) return;
    boardKey = key;
    const position = {};
    const rows = (state?.fen || '8/8/8/8/8/8/8/8').split(' ')[0].split('/');
    rows.forEach((row, index) => {
      let file = 0;
      for (const char of row) {
        if (/^[1-8]$/.test(char)) file += Number(char);
        else if (pieces[char] && file < 8 && index < 8) position[`${'abcdefgh'[file++]}${8 - index}`] = char;
      }
    });
    const black = state?.player_color === 'b';
    const files = [...(black ? 'hgfedcba' : 'abcdefgh')];
    const ranks = black ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    const fragment = document.createDocumentFragment();
    for (const [row, rank] of ranks.entries()) {
      for (const [column, file] of files.entries()) {
        const square = textElement('div', '', `square ${(file.charCodeAt(0) - 97 + rank) % 2 === 1 ? 'dark' : ''}`);
        square.setAttribute('aria-hidden', 'true');
        const piece = position[`${file}${rank}`];
        if (piece) square.append(textElement('span', pieces[piece], `piece${piece === piece.toUpperCase() ? ' white-piece' : ''}`));
        if (column === 0) square.append(textElement('span', rank, 'coordinate rank'));
        if (row === 7) square.append(textElement('span', file, 'coordinate file'));
        fragment.append(square);
      }
    }
    $('board').replaceChildren(fragment);
    $('board').setAttribute('aria-label', state?.fen ? `Current chess position, ${black ? 'Black' : 'White'} at the bottom. FEN: ${state.fen}` : 'No active chess position');
  }

  function setControls() {
    const unavailable = !token || !snapshot || busy;
    for (const button of document.querySelectorAll('form button, .operator-actions button')) button.disabled = unavailable;
    const state = snapshot?.state;
    $('review-game').disabled = unavailable || !state?.game_id || state.phase === 'review' || state.status === 'idle';
    $('reset-game').disabled = unavailable || !state?.game_id || state.status === 'idle';
    for (const button of $('export-form').querySelectorAll('button')) button.disabled = unavailable || !snapshot?.games?.length;
  }

  function renderStatus(state) {
    let status = token ? 'Waiting for the operator to start a game.' : 'Observer link required';
    if (state && token) {
      if (state.status === 'engine_error') status = 'Engine interrupted. Inspect the timeline before restarting.';
      else if (state.status === 'ended') status = `Game ended${state.result ? ` · ${state.result}` : ''}${state.reason ? ` · ${state.reason}` : ''}`;
      else if (state.phase === 'review') status = 'Review mode · player input closed';
      else if (state.status === 'active') status = state.turn === state.player_color && state.legal_moves?.length ? 'Player to move' : 'Waiting for the engine';
    }
    if ($('status').textContent !== status) $('status').textContent = status;
    $('phase-label').textContent = state?.phase || 'Idle';
    $('game-meta').textContent = state?.game_id ? `Game ${state.game_id} · ply ${state.ply ?? 0} · generation ${state.generation} · version ${state.version}` : 'No active game';
    $('fen').textContent = state?.fen || 'No position has been recorded.';
  }

  function renderDiagnostic(diagnostic = {}) {
    const progress = $('diagnostic-progress');
    progress.replaceChildren(document.createTextNode(`${diagnostic.completed_games ?? 0} `), textElement('span', `/ ${diagnostic.required_games ?? 5} games`));
    $('diagnostic-summary').textContent = readable(diagnostic.summary) || (diagnostic.ready ? 'The descriptive evidence checkpoint is ready.' : 'Complete the recorded games to reach the descriptive evidence checkpoint.');
    const counts = document.createDocumentFragment();
    for (const [label, value] of Object.entries(diagnostic.counts || {})) {
      const row = document.createElement('div');
      row.append(textElement('dt', label.replaceAll('_', ' ')), textElement('dd', readable(value)));
      counts.append(row);
    }
    $('diagnostic-counts').replaceChildren(counts);
    const limitations = Array.isArray(diagnostic.limitations) ? diagnostic.limitations : diagnostic.limitations ? [diagnostic.limitations] : [];
    $('diagnostic-limitations').replaceChildren(...limitations.map((item) => textElement('li', readable(item))));
  }

  function renderEvents(events = []) {
    const key = JSON.stringify(events);
    if (key === eventsKey) return;
    eventsKey = key;
    const timeline = $('timeline');
    const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 60;
    const scrollTop = timeline.scrollTop;
    const openDetails = new Set([...timeline.querySelectorAll('details[open]')].map((item) => item.dataset.eventId));
    const fragment = document.createDocumentFragment();
    events.forEach((event, index) => {
      const item = document.createElement('li');
      item.className = 'timeline-event';
      const rawTime = event.timestamp_utc || event.occurred_at || event.timestamp || event.at;
      const time = textElement('time', utc(rawTime), 'event-time');
      if (rawTime && !Number.isNaN(new Date(rawTime).getTime())) time.dateTime = new Date(rawTime).toISOString();
      const content = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'event-title';
      title.append(textElement('strong', event.type || event.kind || 'Recorded event'));
      title.append(textElement('span', event.actor || 'Actor unavailable', 'muted'));
      if (event.san || event.uci) title.append(textElement('span', [event.san, event.uci].filter(Boolean).join(' · '), 'monospace'));
      const metadata = document.createElement('div');
      metadata.className = 'event-meta';
      for (const [label, value] of [['Game', event.game_id], ['Ply', event.ply], ['Decision', event.decision_id]]) {
        if (value !== undefined && value !== null) metadata.append(textElement('span', `${label}: ${value}`));
      }
      const durations = [
        ['Ready → action', event.ready_to_action_ms ?? event.ready_to_move_ms ?? event.timings?.ready_to_action_ms],
        ['Action → accepted', event.action_to_accept_ms],
        ['Action → validated', event.action_to_validation_ms],
        ['Engine wall time', event.engine_wall_ms ?? event.engine_duration_ms ?? event.engine_ms ?? event.timings?.engine_ms],
        ['Event duration', event.duration_ms],
      ];
      for (const [label, value] of durations) {
        if (value !== undefined && value !== null && Number.isFinite(Number(value))) metadata.append(textElement('span', `${label}: ${Number(value).toLocaleString()} ms`));
      }
      content.append(title, metadata);
      if (event.reason) content.append(textElement('p', readable(event.reason), 'event-reason'));
      const memory = event.actor === 'memory' || /memory|retrieval|lesson/.test(event.type || event.kind || '') || event.verification === 'imported_unverified';
      if (memory) {
        const provenance = event.verification || event.verification_status || event.provenance_status || event.memory?.verification || 'imported_unverified';
        content.append(textElement('p', `Memory provenance: ${readable(provenance)}. External claim; this receipt is not proof of learning.`, 'provenance-label'));
      }
      const details = document.createElement('details');
      details.className = 'event-detail';
      details.dataset.eventId = String(event.event_id || index);
      details.open = openDetails.has(details.dataset.eventId);
      details.append(textElement('summary', 'Event details'), textElement('pre', JSON.stringify(event, null, 2)));
      content.append(details);
      item.append(time, content);
      fragment.append(item);
    });
    timeline.replaceChildren(fragment);
    timeline.scrollTop = atBottom ? timeline.scrollHeight : scrollTop;
    $('timeline-empty').hidden = events.length > 0;
    $('event-count').textContent = `${events.length} ${events.length === 1 ? 'event' : 'events'}`;
  }

  function renderGames(games = []) {
    const key = JSON.stringify(games);
    if (key === gamesKey) return;
    gamesKey = key;
    const selected = $('export-game').value;
    const options = [new Option('All recorded games', '')];
    const fragment = document.createDocumentFragment();
    games.forEach((game) => {
      const item = document.createElement('li');
      const label = game.config?.training_label;
      item.append(textElement('p', label ? `${label} · ${game.game_id}` : `Game ${game.game_id}`));
      item.append(textElement('p', [game.phase, game.status, `${game.ply ?? 0} plies`, game.result, game.reason].filter(Boolean).join(' · '), 'caption'));
      const config = game.config || {};
      item.append(textElement('p', [config.player_color ? `Player: ${config.player_color === 'b' ? 'Black' : 'White'}` : '', config.skill_level !== undefined ? `Engine skill: ${config.skill_level}` : '', config.movetime_ms !== undefined ? `Move budget: ${config.movetime_ms} ms` : ''].filter(Boolean).join(' · '), 'caption'));
      fragment.append(item);
      options.push(new Option(label ? `${label} · ${game.game_id}` : game.game_id, game.game_id));
    });
    $('games').replaceChildren(fragment);
    $('export-game').replaceChildren(...options);
    if (games.some((game) => game.game_id === selected)) $('export-game').value = selected;
    $('games-empty').hidden = games.length > 0;
    $('game-count').textContent = `${games.length} ${games.length === 1 ? 'game' : 'games'}`;
  }

  function acceptSnapshot(next, requestSequence) {
    if (!next?.state || typeof next.state !== 'object' || !Object.hasOwn(next.state, 'generation')) throw new Error('The server returned an invalid observation state.');
    if (snapshot) {
      const current = snapshot.state;
      const state = next.state;
      const generation = Number(state.generation);
      const currentGeneration = Number(current.generation);
      if (generation < currentGeneration) return false;
      if (generation === currentGeneration) {
        if (Number(state.version) < Number(current.version)) return false;
        if (state.game_id !== current.game_id && requestSequence < appliedSequence) return false;
        if (Number(state.version) === Number(current.version)
          && ((current.phase === 'review' && state.phase === 'training')
          || (['ended', 'engine_error'].includes(current.status) && state.status === 'active'))) return false;
      } else if (!Number.isFinite(generation) && requestSequence < appliedSequence) return false;
      if (generation === currentGeneration && Number(state.version) === Number(current.version) && requestSequence < appliedSequence) return false;
    }
    snapshot = next;
    appliedSequence = Math.max(appliedSequence, requestSequence);
    renderBoard(next.state);
    renderStatus(next.state);
    renderDiagnostic(next.diagnostic);
    renderGames(next.games);
    renderEvents(next.events);
    setControls();
    return true;
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'omit', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
      if (response.status === 401 || response.status === 403) {
        token = null;
        throw new Error('Observer access was rejected. Reopen the current observer link supplied by the server.');
      }
      return response;
    } finally { clearTimeout(timeout); }
  }

  async function refresh() {
    const requestSequence = ++sequence;
    const response = await request('/api/observer/state');
    if (!response.ok) throw new Error(`State request failed (${response.status}).`);
    acceptSnapshot(await response.json(), requestSequence);
    message('connection', '');
  }

  async function poll() {
    if (!token) return;
    try { await refresh(); }
    catch (error) {
      message('connection', token ? 'Connection interrupted. Showing the last received evidence; reconnecting…' : error.message, 'error');
      setControls();
      renderStatus(snapshot?.state);
    } finally { if (token) setTimeout(poll, 500); }
  }

  async function operate(path, body, successMessage) {
    if (!token || busy) return;
    busy = true;
    setControls();
    message('action-message', '');
    let confirmed = false;
    try {
      const response = await request(path, { method: 'POST', body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        if (response.status >= 500) throw new Error('The server could not confirm the operation.');
        const explanation = [data.code, data.error].filter(Boolean).map(readable).join(': ') || `HTTP ${response.status}`;
        message('action-message', `Operation was not accepted: ${explanation}.`, 'error');
        return;
      }
      confirmed = true;
      message('action-message', successMessage, 'success');
      await refresh();
    } catch (error) {
      message('action-message', !token ? error.message : confirmed
        ? `${successMessage} The latest state has not yet loaded; polling will continue.`
        : 'No definitive receipt was received. The action may have completed. Check the current game and timeline before repeating it.', confirmed ? 'success' : 'error');
    } finally {
      busy = false;
      setControls();
      renderStatus(snapshot?.state);
    }
  }

  $('start-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!$('start-form').reportValidity() || busy || !token) return;
    if (snapshot?.state?.status === 'active' && !window.confirm('End the active game and start a new training game? Recorded evidence will be retained.')) return;
    const body = { player_color: $('player-color').value, skill_level: Number($('skill-level').value), movetime_ms: Number($('movetime').value) };
    if ($('initial-fen').value.trim()) body.initial_fen = $('initial-fen').value.trim();
    if ($('training-label').value.trim()) body.training_label = $('training-label').value.trim();
    operate('/api/observer/start', body, 'Training game started.');
  });

  $('reset-game').addEventListener('click', () => {
    if (busy || !token || !window.confirm('Reset to idle? This ends the active session. Recorded evidence remains available for export.')) return;
    operate('/api/observer/reset', {}, 'Session reset to idle.');
  });

  $('review-game').addEventListener('click', () => {
    if (busy || !token) return;
    if (snapshot?.state?.status === 'active' && !window.confirm('Enter review? This closes player input for the current game.')) return;
    operate('/api/observer/review', {}, 'Review mode requested. Check the current game status.');
  });

  $('memory-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !token) return;
    let body;
    try {
      body = JSON.parse($('memory-json').value);
      if (body?.schema_version !== 1 || !Array.isArray(body.events) || body.events.length === 0) throw new Error('Use schema_version: 1 with a nonempty events array.');
    } catch (error) {
      message('action-message', `Memory JSON was not submitted. ${error.message}`, 'error');
      $('memory-json').focus();
      return;
    }
    operate('/api/observer/memory/import', body, 'Memory evidence receipt imported, unverified. This does not verify that learning occurred.');
  });

  $('export-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!token || busy) return;
    const format = event.submitter?.value;
    if (!['json', 'jsonl', 'pgn'].includes(format)) return;
    busy = true;
    setControls();
    message('action-message', '');
    try {
      const parameters = new URLSearchParams({ format });
      const gameId = $('export-game').value;
      if (gameId) parameters.set('game_id', gameId);
      const response = await request(`/api/observer/export?${parameters}`);
      if (!response.ok) throw new Error(`Export failed (${response.status}).`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      const safeGameId = gameId ? `-${gameId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
      link.download = `quiet-chess-arena${safeGameId}.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message('action-message', `${format.toUpperCase()} export prepared for download.`, 'success');
    } catch (error) { message('action-message', error.message || 'Export could not be downloaded.', 'error'); }
    finally { busy = false; setControls(); }
  });

  renderBoard(null);
  setControls();
  if (token) poll();
  else {
    renderStatus(null);
    message('connection', 'Open the original observer URL containing #token=… to connect. The token is removed from the address bar and is not saved in browser storage.', 'error');
  }
})();
