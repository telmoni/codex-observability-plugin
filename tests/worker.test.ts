import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { traceIdOf } from '../src/record.js';
import {
  ENDPOINT,
  FakeTelmoni,
  KEY,
  Rollout,
  SECRETS,
  SESSION,
  T0,
  assertMetadataOnly,
  attributes,
  endMs,
  keptText,
  logOf,
  makeHome,
  pluginDir,
  runWorker,
  startMs,
  stateOf,
  writeKeyFile,
} from './helpers.js';

const ENV = { TELMONI_API_KEY: KEY, TELMONI_ENDPOINT: ENDPOINT };

const names = (telmoni: FakeTelmoni, traceId: string): string[] =>
  (telmoni.traces().get(traceId) ?? []).map((span) => span.name);

/** A trace's spans of one operation: `invoke_agent` the agent's own, `chat` a model call, `execute_tool` a tool call. */
const kindOf = (telmoni: FakeTelmoni, traceId: string, operation: string) =>
  (telmoni.traces().get(traceId) ?? []).filter(
    (span) => attributes(span)['gen_ai.operation.name'] === operation,
  );

describe('a turn sent', () => {
  it('goes as a trace of codex: its model calls with their tokens, its commands, its times, and nothing said', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    const turnId = rollout.turn(2);
    await runWorker(rollout.stop(), home, telmoni);

    const traceId = traceIdOf(SESSION, turnId);
    const spans = telmoni.traces().get(traceId) ?? [];
    expect(spans.length).toBeGreaterThan(0);
    const root = kindOf(telmoni, traceId, 'invoke_agent')[0];
    expect(root?.name).toBe('invoke_agent codex');
    expect(attributes(root!)['gen_ai.conversation.id']).toBe(SESSION);

    const models = kindOf(telmoni, traceId, 'chat');
    expect(models).toHaveLength(2);
    const first = attributes(models[0]!);
    expect(first['gen_ai.request.model']).toBe('gpt-6-sol');
    expect(first['gen_ai.provider.name']).toBe('openai');
    expect(first['gen_ai.usage.input_tokens']).toBe(15000);
    expect(first['gen_ai.usage.output_tokens']).toBe(120);
    expect(first['gen_ai.usage.cache_read.input_tokens']).toBe(12000);

    const tools = kindOf(telmoni, traceId, 'execute_tool');
    expect(tools.map((span) => attributes(span)['gen_ai.tool.name'])).toEqual(['shell', 'shell']);
    expect(endMs(tools[0]!) - startMs(tools[0]!)).toBe(1500);
    expect(startMs(root!)).toBe(T0 + 1000);

    expect(stateOf(home).sent).toEqual([traceId]);
    assertMetadataOnly(telmoni.text() + keptText(home) + logOf(home), [rollout.path, rollout.cwd]);
  });

  it('names the Codex version as the release', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    expect(telmoni.resources().some((resource) => resource['service.version'] === '0.167.0')).toBe(
      true,
    );
  });
});

describe('where a session starts', () => {
  it('at the turn the first stop ended: history before stays home', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    const before = rollout.turn(1);
    const after = rollout.turn(1);
    await runWorker(rollout.stop(), home, telmoni);
    expect(telmoni.traces().has(traceIdOf(SESSION, before))).toBe(false);
    expect(telmoni.traces().has(traceIdOf(SESSION, after))).toBe(true);
  });
});

describe('a turn not closed yet', () => {
  it('is waited for: Codex closes a turn only after its Stop hook returns', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    const turnId = rollout.prompt();
    rollout.reply();
    const working = runWorker(rollout.stop(), home, telmoni, undefined, {
      settleMs: 20,
      settleMaxMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    rollout.complete();
    await working;
    expect(telmoni.traces().has(traceIdOf(SESSION, turnId))).toBe(true);
    expect(logOf(home)).not.toContain('not over yet');
  });

  it('is at work, not held, where it began after the hook ran', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    const ended = rollout.turn(0);
    const stop = rollout.stop();
    rollout.prompt();
    await runWorker(stop, home, telmoni);
    expect(telmoni.traces().has(traceIdOf(SESSION, ended))).toBe(true);
    expect(logOf(home)).not.toContain('not over yet');
  });

  it('is held, and sent once Codex closes it', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    const turnId = rollout.prompt();
    rollout.reply({ tool: true }).command().toolOutput();
    await runWorker(rollout.stop(), home, telmoni);
    expect(telmoni.requests).toHaveLength(0);
    expect(logOf(home)).toContain('its turn is not over yet');
    rollout.reply().complete();
    await runWorker(rollout.stop(), home, telmoni);
    expect(telmoni.traces().has(traceIdOf(SESSION, turnId))).toBe(true);
  });
});

describe('outcomes', () => {
  it('an interrupted turn is a cancelled trace', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    const turnId = rollout.prompt();
    rollout.reply({ tool: true }).command().abort();
    await runWorker(rollout.stop(), home, telmoni);
    expect(names(telmoni, traceIdOf(SESSION, turnId)).length).toBeGreaterThan(0);
  });

  it('a session that ends with its turn open sends that turn', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    const first = rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    const open = rollout.prompt();
    rollout.reply({ tool: true }).command();
    await runWorker(rollout.end(), home, telmoni);
    expect(telmoni.traces().has(traceIdOf(SESSION, first))).toBe(true);
    expect(telmoni.traces().has(traceIdOf(SESSION, open))).toBe(true);
  });
});

describe('the key', () => {
  it('from the key file, where the environment names none', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    writeKeyFile(home, { apiKey: KEY, endpoint: ENDPOINT });
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni, {});
    expect(telmoni.requests.length).toBeGreaterThan(0);
  });

  it('none: said once, nothing sent', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni, {});
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni, {});
    expect(telmoni.requests).toHaveLength(0);
    expect(logOf(home).match(/no key/g)).toHaveLength(1);
  });

  it('without an endpoint: said once, nothing sent', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni, { TELMONI_API_KEY: KEY });
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni, { TELMONI_API_KEY: KEY });
    expect(telmoni.requests).toHaveLength(0);
    expect(logOf(home).match(/no endpoint/g)).toHaveLength(1);
  });
});

describe('tags', () => {
  it('of the nearest .telmoni-tags.json at or above the session’s folder', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    writeFileSync(join(rollout.cwd, '.telmoni-tags.json'), JSON.stringify({ repo: 'telmoni' }));
    const turnId = rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    const root = kindOf(telmoni, traceIdOf(SESSION, turnId), 'invoke_agent')[0];
    expect(attributes(root!)['telmoni.tag.repo']).toBe('telmoni');
  });
});

describe('the plugin’s folder', () => {
  it('is PLUGIN_DATA where Codex gives one', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const data = join(home, '.codex', 'plugins', 'data', 'telmoni-observability-telmoni-plugins');
    mkdirSync(data, { recursive: true });
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni, { ...ENV, PLUGIN_DATA: data });
    expect(keptText(home)).toBe('');
    expect(pluginDir(home)).not.toBe(data);
  });
});

const OTHER = '019a6f2e-5c00-7d2a-9b1e-4f0c3a2b1d11';

describe('content', () => {
  it('leaves only where both the switch and the project’s content mode are on', async () => {
    for (const [mode, sent] of [
      ['on', true],
      ['off', false],
    ] as const) {
      const home = makeHome();
      const telmoni = new FakeTelmoni();
      telmoni.mode = mode;
      const rollout = new Rollout(home);
      rollout.turn(1);
      await runWorker(rollout.stop(), home, telmoni, {
        ...ENV,
        TELMONI_CAPTURE_CONTENT: '1',
      });
      expect(telmoni.text().includes(SECRETS.prompt), `content mode ${mode}`).toBe(sent);
      expect(telmoni.text().includes(SECRETS.output), `content mode ${mode}`).toBe(sent);
      // Never the instructions Codex hands the model, the reasoning it keeps encrypted, or a place.
      for (const never of [SECRETS.instructions, SECRETS.encrypted, rollout.path, rollout.cwd])
        expect(telmoni.text()).not.toContain(never);
    }
  });
});

describe('delivery', () => {
  it('sends each turn once, however many stops it hears', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    const turnId = rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    await runWorker(rollout.stop(), home, telmoni);
    await runWorker(rollout.end(), home, telmoni);
    expect([...telmoni.traces().keys()]).toEqual([traceIdOf(SESSION, turnId)]);
  });

  it('keeps a turn Telmoni could not take and sends it first at the next stop, the later turn behind it', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    const first = rollout.turn(0);
    telmoni.offline = true;
    await runWorker(rollout.stop(), home, telmoni);
    expect(stateOf(home).pending).toHaveLength(1);
    expect(logOf(home)).toContain(`kept ${traceIdOf(SESSION, first).slice(0, 8)}`);

    const second = rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    expect(stateOf(home).pending).toHaveLength(2);

    telmoni.offline = false;
    const third = rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    expect([...telmoni.traces().keys()]).toEqual(
      [first, second, third].map((turnId) => traceIdOf(SESSION, turnId)),
    );
    expect(stateOf(home).pending).toEqual([]);
    // Kept with the Codex version it was sent as.
    expect(telmoni.resources().every((resource) => resource['service.version'] === '0.167.0')).toBe(
      true,
    );
  });

  it('drops a turn kept in a shape no longer sent, says so, and sends the next', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    rollout.turn(0);
    telmoni.offline = true;
    await runWorker(rollout.stop(), home, telmoni);
    const state = stateOf(home);
    const [kept] = state.pending as { trace: unknown; release?: string }[];
    writeFileSync(
      join(pluginDir(home), `${SESSION}.json`),
      JSON.stringify({ ...state, pending: [{ run: kept!.trace, release: kept!.release }] }),
    );

    telmoni.offline = false;
    const next = rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    expect(logOf(home)).toContain('dropped 1 kept in a shape no longer sent');
    expect([...telmoni.traces().keys()]).toEqual([traceIdOf(SESSION, next)]);
    expect(stateOf(home).pending).toEqual([]);
  });

  it('does not keep a turn Telmoni refused for good', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    telmoni.answers = [{ status: 400, body: { code: 3, message: '/errors/request/invalid: no' } }];
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    expect(stateOf(home).pending).toEqual([]);
    expect(logOf(home)).toContain('refused, not sent again');
  });

  it('sends what another session kept, where it was meant for the same key and endpoint', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const left = new Rollout(home, OTHER);
    const leftTurn = left.turn(0);
    telmoni.offline = true;
    await runWorker(left.stop(), home, telmoni);
    // Another key's kept turns go nowhere they were not meant to.
    const elsewhere = new Rollout(home, '019a6f2e-5c00-7d2a-9b1e-4f0c3a2b1d12');
    elsewhere.turn(0);
    await runWorker(elsewhere.stop(), home, telmoni, {
      ...ENV,
      TELMONI_API_KEY: 'tm_another_key',
    });
    telmoni.offline = false;

    const rollout = new Rollout(home);
    const own = rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    expect(new Set(telmoni.traces().keys())).toEqual(
      new Set([traceIdOf(SESSION, own), traceIdOf(OTHER, leftTurn)]),
    );
    expect(stateOf(home, OTHER).pending).toEqual([]);
    expect(stateOf(home, '019a6f2e-5c00-7d2a-9b1e-4f0c3a2b1d12').pending).toHaveLength(1);
  });
});

describe('the key file', () => {
  it('is read while it is the person’s own and shut to everyone else, with its endpoint', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    writeKeyFile(home, { apiKey: KEY, endpoint: 'https://file.example.com' });
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni, {});
    expect(telmoni.requests[0]?.url).toMatch(/^https:\/\/file\.example\.com\//);
    expect(telmoni.requests[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('is found in CODEX_HOME where it is set', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const codexHome = join(home, 'elsewhere');
    mkdirSync(codexHome);
    writeFileSync(
      join(codexHome, 'telmoni.json'),
      JSON.stringify({ apiKey: KEY, endpoint: ENDPOINT }),
      {
        mode: 0o600,
      },
    );
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni, { CODEX_HOME: codexHome });
    expect(telmoni.requests.length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')(
    'is passed over where it is open to others, and the log says why',
    async () => {
      const home = makeHome();
      const telmoni = new FakeTelmoni();
      writeKeyFile(home, { apiKey: KEY }, 0o644);
      const rollout = new Rollout(home);
      rollout.turn(0);
      await runWorker(rollout.stop(), home, telmoni, {});
      expect(telmoni.requests).toEqual([]);
      expect(logOf(home)).toContain('key file not read: open to other users; chmod 600 it');
    },
  );

  it('gives way to a key in the environment, never lending it its endpoint', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    writeKeyFile(home, { apiKey: 'tm_file_key', endpoint: 'https://file.example.com' });
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    expect(telmoni.requests[0]?.url).toMatch(/^https:\/\/telmoni\.example\.com\//);
    expect(telmoni.requests[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});

describe('the session’s state', () => {
  it('left as it is where it cannot be read, and nothing sent', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    writeFileSync(join(pluginDir(home), `${SESSION}.json`), '{not json');
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    expect(telmoni.traces().size).toBe(1);
    expect(logOf(home)).toContain('state unreadable');
  });

  it('left to another hook at work on the session', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    const lock = join(pluginDir(home), `${SESSION}.lock`);
    writeFileSync(lock, 'another');
    const now = new Date();
    utimesSync(lock, now, now);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni, undefined, { lockWaitMs: 50 });
    expect(telmoni.traces().size).toBe(1);
    expect(logOf(home)).toContain('another hook holds the session');
  });

  it('reads the rollout from the turn it is at, never again from the top', async () => {
    const home = makeHome();
    const telmoni = new FakeTelmoni();
    const rollout = new Rollout(home);
    rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    const second = rollout.turn(0);
    await runWorker(rollout.stop(), home, telmoni);
    const { offset } = stateOf(home) as { offset: number };
    const line = rollout.lines.findIndex(
      (entry) => (entry.payload as { turn_id?: string }).turn_id === second,
    );
    expect(offset).toBeGreaterThan(0);
    expect(line).toBeGreaterThan(0);
    expect(telmoni.traces().size).toBe(2);
  });
});
