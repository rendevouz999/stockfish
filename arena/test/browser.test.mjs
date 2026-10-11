import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { braveLaunchCommand, openBrave } from '../browser.mjs';

const playerUrl = `http://127.0.0.1:8124/player#token=${'p'.repeat(43)}`;
const observerUrl = `http://127.0.0.1:8124/observer#token=${'o'.repeat(43)}`;
const braveRoot = 'F:\\Portable Apps\\Brave Isolated';
const executable = `${braveRoot}\\App\\brave.exe`;
const options = { browser: 'brave', platform: 'win32', env: { PATH: 'existing-path', TEMP: 'old-temp' }, braveRoot, isFile: file => file === executable, playerUrl, observerUrl };

test('portable Brave uses the selected root, isolated child environment and separate safe URL args', () => {
  const command = braveLaunchCommand(options);
  assert.equal(command.executable, executable);
  assert.deepEqual(command.args, [
    `--user-data-dir=${braveRoot}\\UserData`, `--disk-cache-dir=${braveRoot}\\Cache`,
    `--crash-dumps-dir=${braveRoot}\\CrashDumps`, '--no-first-run', '--no-default-browser-check', observerUrl, playerUrl,
  ]);
  assert.equal(command.options.shell, false);
  assert.equal(command.options.stdio, 'ignore');
  assert.equal(command.options.env.TEMP, `${braveRoot}\\Temp`);
  assert.equal(command.options.env.TMP, `${braveRoot}\\Temp`);
  assert.equal(command.options.env.LOCALAPPDATA, `${braveRoot}\\AppData\\Local`);
  assert.equal(command.options.env.APPDATA, `${braveRoot}\\AppData\\Roaming`);
  assert.equal(command.options.env.USERPROFILE, `${braveRoot}\\Profile`);
  assert.equal(command.options.env.HOME, `${braveRoot}\\Profile`);
  assert.equal(command.options.env.HOMEDRIVE, 'F:');
  assert.equal(command.options.env.HOMEPATH, '\\Portable Apps\\Brave Isolated\\Profile');
  assert.equal(command.options.env.PATH, 'existing-path');
  assert.equal(options.env.TEMP, 'old-temp', 'parent environment is not modified');
  assert.equal(command.args.some(arg => arg.includes('--remote-debugging') || arg.includes('--disable-')), false);
  assert.ok(command.directories.includes(`${braveRoot}\\Downloads`));
  const other = braveLaunchCommand({ ...options, braveRoot: 'D:\\Brave', isFile: () => true });
  assert.equal(other.options.env.HOMEDRIVE, 'D:');
  assert.equal(other.options.env.HOMEPATH, '\\Brave\\Profile');
});

test('portable Brave rejects missing roots/apps, unsupported browsers/platforms and unsafe destinations', () => {
  assert.throws(() => braveLaunchCommand({ ...options, isFile: () => false }), /not found/i);
  assert.throws(() => braveLaunchCommand({ ...options, braveRoot: undefined }), /root/i);
  for (const root of ['relative', 'C:relative', '\\\\server\\share', 'F:\\bad"path', 'F:\\bad\npath']) assert.throws(() => braveLaunchCommand({ ...options, braveRoot: root }), /root/i);
  assert.throws(() => braveLaunchCommand({ ...options, browser: 'brave & calc.exe' }), /browser/i);
  assert.throws(() => braveLaunchCommand({ ...options, platform: 'linux' }), /Windows/i);
  for (const url of ['https://evil.example/player', 'file:///C:/test', playerUrl + '&extra=1', playerUrl.replace('/player', '/observer'), playerUrl.replace(':8124', ':8125')]) {
    assert.throws(() => braveLaunchCommand({ ...options, playerUrl: url }), /URL|origin/i);
  }
});

test('portable Brave prepares only scoped folders and spawns directly; never falls back', async () => {
  const calls = [];
  const directories = [];
  const spawnProcess = (...args) => {
    calls.push(args);
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  await openBrave(options, { spawnProcess, makeDirectory: (path, config) => directories.push({ path, config }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], executable);
  assert.deepEqual(calls[0][1].slice(-2), [observerUrl, playerUrl]);
  assert.ok(directories.length);
  assert.ok(directories.every(({ path, config }) => path.startsWith(braveRoot + '\\') && config.recursive === true));
  const failed = () => {
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('error', new Error('Simulated launch error')));
    return child;
  };
  await assert.rejects(openBrave(options, { spawnProcess: failed, makeDirectory: () => {} }), /launch/i);
  let touched = false;
  await assert.rejects(openBrave({ ...options, isFile: () => false }, { spawnProcess, makeDirectory: () => { touched = true; } }), /not found/i);
  assert.equal(touched, false, 'an invalid installation does not create folders');
});

test('double-click portable launcher uses verified default or environment prompt without argument interpolation', async () => {
  const { readFileSync } = await import('node:fs');
  const launcher = readFileSync(new URL('../../start-arena-brave.cmd', import.meta.url), 'utf8');
  assert.match(launcher, /setlocal DisableDelayedExpansion/i);
  assert.match(launcher, /if exist "F:\\Brave-Isolated\\App\\brave\.exe"/i);
  assert.match(launcher, /set \/p "QUIET_CHESS_BRAVE_ROOT=/i);
  assert.doesNotMatch(launcher, /%~?1|%\*|%QUIET_CHESS_BRAVE_ROOT%/i);
  assert.match(launcher, /node arena\\server\.mjs --open --browser brave/);
});
