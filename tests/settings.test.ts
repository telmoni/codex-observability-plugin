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
  it('come from the SDKs’ own variables first, the file read only for what they leave unset', () => {
    keyFile({ apiKey: 'telmoni_file', endpoint: 'https://file.example' });
    expect(settingsFrom(env({ TELMONI_API_KEY: 'telmoni_env', TELMONI_ENDPOINT: 'https://env.example' }))).toMatchObject({ apiKey: 'telmoni_env', endpoint: 'https://env.example' });
    expect(settingsFrom(env({ TELMONI_API_KEY: 'telmoni_env' }))).toMatchObject({ apiKey: 'telmoni_env', endpoint: 'https://file.example' });
    expect(settingsFrom(env())).toMatchObject({ apiKey: 'telmoni_file', endpoint: 'https://file.example', dir: join(codex(), 'telmoni') });
  });

  it.skipIf(process.platform === 'win32')('are read from the file only where it is shut to everyone but its owner, as ssh reads a key', () => {
    for (const mode of [0o644, 0o640, 0o604, 0o620]) {
      keyFile({ apiKey: 'telmoni_file', endpoint: 'https://elsewhere.example' }, mode);
      expect(settingsFrom(env())).toMatchObject({ apiKey: undefined, endpoint: undefined, keyFileProblem: 'open to other users; chmod 600 it' });
    }
    // With the key in the environment, the file still names what it may have held, the endpoint among it.
    expect(settingsFrom(env({ TELMONI_API_KEY: 'telmoni_env' }))).toMatchObject({ apiKey: 'telmoni_env', endpoint: undefined, keyFileProblem: 'open to other users; chmod 600 it' });
    keyFile({ apiKey: 'telmoni_file' }, 0o400);
    expect(settingsFrom(env()).apiKey).toBe('telmoni_file');
  });

  it.skipIf(process.platform === 'win32')('leave the file unread where both are in the environment', () => {
    keyFile({ apiKey: 'telmoni_file' }, 0o644);
    expect(settingsFrom(env({ TELMONI_API_KEY: 'telmoni_env', TELMONI_ENDPOINT: 'https://env.example' }))).toStrictEqual({
      apiKey: 'telmoni_env',
      endpoint: 'https://env.example',
      dir: join(codex(), 'telmoni'),
      keyFileName: '$CODEX_HOME/telmoni.json',
    });
  });

  it('name the key file to the log by CODEX_HOME where it is set, since the log holds no path', () => {
    const both = { TELMONI_API_KEY: 'telmoni_env', TELMONI_ENDPOINT: 'https://env.example' };
    expect(settingsFrom(env(both)).keyFileName).toBe('$CODEX_HOME/telmoni.json');
    expect(settingsFrom(both).keyFileName).toBe('~/.codex/telmoni.json');
  });

  it('pass over a file with a field there but empty or no string, rather than send the key to the default endpoint', () => {
    for (const endpoint of ['', '   ', null, 443, ['https://self.example']]) {
      keyFile({ apiKey: 'telmoni_file', endpoint });
      expect(settingsFrom(env())).toMatchObject({ apiKey: undefined, endpoint: undefined, keyFileProblem: 'endpoint empty or not a string' });
    }
    keyFile({ apiKey: '', endpoint: 'https://self.example' });
    expect(settingsFrom(env({ TELMONI_API_KEY: 'telmoni_env' }))).toMatchObject({ endpoint: undefined, keyFileProblem: 'apiKey empty or not a string' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('say a file they may not open is unreadable, by kind', () => {
    keyFile({ apiKey: 'telmoni_file' }, 0o000);
    expect(settingsFrom(env()).keyFileProblem).toBe('unreadable (Error:EACCES)');
  });

  it('say by kind what is wrong with a file that is no key file', () => {
    keyFile('{"apiKey": ');
    expect(settingsFrom(env()).keyFileProblem).toBe('not JSON');
    keyFile('["telmoni_file"]');
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
