import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

const isExistingFile = path => { try { return statSync(path).isFile(); } catch { return false; } };

export function braveLaunchCommand({ browser = 'brave', braveRoot, playerUrl, observerUrl, platform = process.platform, env = process.env, isFile = isExistingFile }) {
  if (browser !== 'brave') throw new Error('The supported auto-open browser is brave');
  if (platform !== 'win32') throw new Error('Portable Brave auto-open currently supports Windows only; use the printed links manually');
  if (typeof braveRoot !== 'string' || !/^[a-zA-Z]:[\\/]/.test(braveRoot) || /["<>|?*\x00-\x1f]/.test(braveRoot)) throw new Error('brave-root must be an explicit absolute local Windows folder containing App\\brave.exe');
  const root = win32.normalize(braveRoot);
  const executable = win32.join(root, 'App', 'brave.exe');
  if (!isFile(executable)) throw new Error('Portable Brave was not found at the selected root\\App\\brave.exe; no other browser was opened');
  const urls = [[observerUrl, '/observer'], [playerUrl, '/player']].map(([value, route]) => {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid arena URL'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== route || url.search || !/^#token=[A-Za-z0-9_-]{43}$/.test(url.hash)) throw new Error('Only exact localhost arena capability URLs may be opened');
    return url;
  });
  if (urls[0].origin !== urls[1].origin) throw new Error('Arena URLs must share one origin');
  const folder = name => win32.join(root, name);
  const profile = folder('Profile');
  const directories = ['UserData', 'Cache', 'CrashDumps', 'Temp', 'Downloads', 'AppData\\Local', 'AppData\\Roaming', 'Profile'].map(folder);
  return {
    executable,
    args: [`--user-data-dir=${folder('UserData')}`, `--disk-cache-dir=${folder('Cache')}`, `--crash-dumps-dir=${folder('CrashDumps')}`, '--no-first-run', '--no-default-browser-check', ...urls.map(url => url.href)],
    directories,
    options: {
      shell: false, detached: true, stdio: 'ignore', windowsHide: false,
      env: { ...env, TEMP: folder('Temp'), TMP: folder('Temp'), LOCALAPPDATA: folder('AppData\\Local'), APPDATA: folder('AppData\\Roaming'), USERPROFILE: profile, HOME: profile, HOMEDRIVE: profile.slice(0, 2), HOMEPATH: profile.slice(2) },
    },
  };
}

export async function openBrave(options, { spawnProcess = spawn, makeDirectory = mkdirSync } = {}) {
  const command = braveLaunchCommand(options);
  for (const directory of command.directories) makeDirectory(directory, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawnProcess(command.executable, command.args, command.options);
    child.once('error', () => reject(new Error('Portable Brave launch failed; open the printed links manually in your existing isolated Brave')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
