import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settingsFrom } from '../src/settings';
import { tempDir } from './helpers';

let home: { path: string; remove: () => void };

beforeEach(() => {
  home = tempDir();
});

afterEach(() => {
  home.remove();
});

const codex = (): string => join(home.path, 'codex');
const env = (more: Record<string, string> = {}): NodeJS.ProcessEnv => ({ CODEX_HOME: codex(), ...more });

/** `telmoni.json` in the folder Codex runs with, of `mode` whatever the umask made of it. */
function keyFile(content: unknown, mode = 0o600): void {
  mkdirSync(codex(), { recursive: true });
  const path = join(codex(), 'telmoni.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  chmodSync(path, mode);
}

describe('the key and the endpoint', () => {
  it('come as a pair, the environment’s key with the environment’s endpoint, else the file’s with the file’s', () => {
    keyFile({ apiKey: 'tm_file', endpoint: 'https://file.example' });
    expect(settingsFrom(env({ TELMONI_API_KEY: 'tm_env', TELMONI_ENDPOINT: 'https://env.example' }))).toMatchObject({ apiKey: 'tm_env', endpoint: 'https://env.example' });
    // The environment's key never goes to the file's endpoint, nor the file's key to the environment's.
    expect(settingsFrom(env({ TELMONI_API_KEY: 'tm_env' }))).toMatchObject({ apiKey: 'tm_env', endpoint: undefined });
    expect(settingsFrom(env({ TELMONI_ENDPOINT: 'https://env.example' }))).toMatchObject({ apiKey: 'tm_file', endpoint: 'https://file.example' });
    expect(settingsFrom(env())).toMatchObject({ apiKey: 'tm_file', endpoint: 'https://file.example', dir: join(codex(), 'telmoni') });
  });

  it.skipIf(process.platform === 'win32')('are read from the file only where it is shut to everyone but its owner, as ssh reads a key', () => {
    for (const mode of [0o644, 0o640, 0o604, 0o620]) {
      keyFile({ apiKey: 'tm_file', endpoint: 'https://elsewhere.example' }, mode);
      expect(settingsFrom(env())).toMatchObject({ apiKey: undefined, endpoint: undefined, keyFileProblem: 'open to other users; chmod 600 it' });
    }
    // With the key in the environment, the file is not read: its endpoint was never the environment key's.
    expect(settingsFrom(env({ TELMONI_API_KEY: 'tm_env' })).keyFileProblem).toBeUndefined();
    keyFile({ apiKey: 'tm_file' }, 0o400);
    expect(settingsFrom(env()).apiKey).toBe('tm_file');
  });

  it.skipIf(process.platform === 'win32')('leave the file unread where the key is in the environment', () => {
    keyFile({ apiKey: 'tm_file' }, 0o644);
    expect(settingsFrom(env({ TELMONI_API_KEY: 'tm_env', TELMONI_ENDPOINT: 'https://env.example' }))).toStrictEqual({
      apiKey: 'tm_env',
      endpoint: 'https://env.example',
      dir: join(codex(), 'telmoni'),
      keyFileName: '$CODEX_HOME/telmoni.json',
    });
  });

  it('take CODEX_HOME only where it is absolute, never under the session’s working folder', () => {
    const read = settingsFrom({ CODEX_HOME: 'relative', TELMONI_API_KEY: 'tm_env' });
    expect(read.dir).not.toContain('relative');
    expect(read.keyFileName).toBe('~/.codex/telmoni.json');
  });

  it('name the key file to the log by CODEX_HOME where it is set, since the log holds no path', () => {
    const both = { TELMONI_API_KEY: 'tm_env', TELMONI_ENDPOINT: 'https://env.example' };
    expect(settingsFrom(env(both)).keyFileName).toBe('$CODEX_HOME/telmoni.json');
    expect(settingsFrom(both).keyFileName).toBe('~/.codex/telmoni.json');
  });

  it('pass over a file with a field there but empty or no string, rather than send the key to the default endpoint', () => {
    for (const endpoint of ['', '   ', null, 443, ['https://self.example']]) {
      keyFile({ apiKey: 'tm_file', endpoint });
      expect(settingsFrom(env())).toMatchObject({ apiKey: undefined, endpoint: undefined, keyFileProblem: 'endpoint empty or not a string' });
    }
    keyFile({ apiKey: '', endpoint: 'https://self.example' });
    expect(settingsFrom(env())).toMatchObject({ apiKey: undefined, endpoint: undefined, keyFileProblem: 'apiKey empty or not a string' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('say a file they may not open is unreadable, by kind', () => {
    keyFile({ apiKey: 'tm_file' }, 0o000);
    expect(settingsFrom(env()).keyFileProblem).toBe('unreadable (Error:EACCES)');
  });

  it('say by kind what is wrong with a file that is no key file', () => {
    keyFile('{"apiKey": ');
    expect(settingsFrom(env()).keyFileProblem).toBe('not JSON');
    keyFile('["tm_file"]');
    expect(settingsFrom(env()).keyFileProblem).toBe('not a JSON object');
    keyFile('x'.repeat(70_000));
    expect(settingsFrom(env()).keyFileProblem).toBe('too large');
    expect(settingsFrom(env({ CODEX_HOME: join(home.path, 'none') })).keyFileProblem).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('pass over a file another user owns, which no chmod of the person’s mends', () => {
    mkdirSync(codex(), { recursive: true });
    // Root's, and open to everyone: the owner is what is named.
    symlinkSync('/etc/passwd', join(codex(), 'telmoni.json'));
    expect(settingsFrom(env()).keyFileProblem).toBe('owned by another user');
  });

  it.skipIf(process.platform === 'win32')('never wait on a FIFO nothing writes to', () => {
    mkdirSync(codex(), { recursive: true });
    execFileSync('mkfifo', [join(codex(), 'telmoni.json')]);
    expect(settingsFrom(env()).keyFileProblem).toBe('not a file');
  });
});
