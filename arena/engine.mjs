import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const enginePath = fileURLToPath(new URL('../vendor/stockfish-18-lite-single.js', import.meta.url));

export class StockfishEngine {
  choose({ initialFen, moves, skill_level, movetime_ms, signal }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Engine search cancelled')); return; }
      // ponytail: one isolated process per turn; reuse only if startup becomes a measured bottleneck.
      const child = spawn(process.execPath, [enginePath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let settled = false;
      let stage = 'uci';
      let stderr = '';
      const lines = createInterface({ input: child.stdout });
      const finish = (error, move) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        lines.close();
        child.stdin.destroy();
        child.kill();
        if (error) reject(error); else resolve(move);
      };
      const cancel = () => finish(new Error('Engine search cancelled'));
      const timeout = setTimeout(() => finish(new Error('Stockfish timed out during initialization or search')), Math.max(15000, movetime_ms + 10000));
      signal?.addEventListener('abort', cancel, { once: true });
      child.on('error', error => finish(error));
      child.stdin.on('error', error => finish(error));
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
      child.on('exit', (code, sig) => { if (!settled) finish(new Error(`Stockfish exited early (${code ?? sig}): ${stderr}`)); });
      const send = command => child.stdin.write(`${command}\n`);
      lines.on('line', line => {
        if (stage === 'uci' && line.trim() === 'uciok') {
          stage = 'ready';
          send('setoption name Threads value 1');
          send('setoption name Hash value 16');
          send(`setoption name Skill Level value ${skill_level}`);
          send('ucinewgame');
          send('isready');
        } else if (stage === 'ready' && line.trim() === 'readyok') {
          stage = 'search';
          send(`position fen ${initialFen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`);
          send(`go movetime ${movetime_ms}`);
        } else if (stage === 'search' && line.startsWith('bestmove ')) {
          finish(null, line.trim().split(/\s+/)[1]);
        }
        // Deliberately discard engine info/PV/evaluation output. It is never player data.
      });
      send('uci');
    });
  }
}
