import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type Row, readRollout } from '../src/transcript.js';
import { mkfifoSync } from './fifo.js';
import { Rollout, SECRETS, assertMetadataOnly, makeHome } from './helpers.js';

const read = (rollout: Rollout, content = false, from = 0) => {
  const result = readRollout(rollout.path, { content, from });
  if ('problem' in result) throw new Error(result.problem);
  return result;
};

const kinds = (rows: readonly Row[]): string[] => rows.map((row) => row.kind);

describe('the rollout', () => {
  it('names the session: Codex’s version and the provider', () => {
    expect(read(new Rollout(makeHome())).session).toEqual({
      cliVersion: '0.167.0',
      provider: 'openai',
    });
    expect(read(new Rollout(makeHome(), undefined, { cli_version: '../x' })).session).toEqual({
      provider: 'openai',
    });
  });

  it('reads a turn’s rows in order, each with its offset, time and turn', () => {
    const rollout = new Rollout(makeHome());
    const turnId = rollout.turn(1);
    const { rows } = read(rollout);
    expect(kinds(rows)).toEqual([
      'turn_started',
      'turn_context',
      'settings',
      'prompt',
      'usage',
      'tool',
      'tool_output',
      'usage',
      'turn_complete',
    ]);
    expect(rows.every((row) => row.turnId === turnId || row.kind === 'settings')).toBe(true);
    expect(rows.map((row) => row.offset)).toEqual(
      [...rows.map((row) => row.offset)].sort((a, b) => a - b),
    );
    expect(rows.every((row) => typeof row.at === 'number')).toBe(true);
  });

  it('reads tokens as Codex counts them, the cache’s reads and writes apart', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply({
      tokens: { input: 900, cached: 600, cacheWrite: 100, output: 50, reasoning: 20 },
    });
    const usage = read(rollout).rows.find((row) => row.kind === 'usage');
    expect(usage).toMatchObject({
      tokens: { input: 900, cacheRead: 600, cacheWrite: 100, output: 50, reasoning: 20 },
    });
  });

  it('reads each tool by its kind, failed where Codex says so or its command exited non-zero', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply({ tool: true });
    rollout.command().command({ exitCode: 2 }).command({ status: 'declined', exitCode: 0 });
    rollout.edit().mcp('github', 'search_issues', { error: true }).search();
    const tools = read(rollout)
      .rows.filter((row) => row.kind === 'tool')
      .map((row) => (row.kind === 'tool' ? row.tool : undefined));
    expect(tools.map((tool) => [tool?.name, tool?.failed, tool?.declined])).toEqual([
      ['shell', false, false],
      ['shell', true, false],
      ['shell', false, true],
      ['apply_patch', false, false],
      ['mcp__github__search_issues', true, false],
      ['web_search', false, false],
    ]);
    expect((tools[0]?.end ?? 0) - (tools[0]?.start ?? 0)).toBe(1500);
  });

  it('reads Codex’s other tools by their kind, and never a command the person ran themselves', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.reply({ tool: true });
    rollout.command({ source: 'user_shell' });
    rollout
      .item({
        type: 'DynamicToolCall',
        tool: 'lookup',
        arguments: {},
        status: 'failed',
        success: false,
      })
      .item({
        type: 'CollabAgentToolCall',
        tool: 'spawn_agent',
        status: 'completed',
        prompt: SECRETS.prompt,
      })
      .item({ type: 'WebSearch', query: SECRETS.query, action: { type: 'search' } })
      .item({ type: 'ImageView', path: `/home/someone/${SECRETS.path}` })
      .item({ type: 'Extension', kind: 'clock.sleep', durationMs: 100 })
      .item({
        type: 'Extension',
        kind: 'image_gen.generation',
        status: 'failed',
        failure: { message: SECRETS.error },
      })
      .item({ type: 'Plan', text: SECRETS.reply });
    const tools = read(rollout)
      .rows.filter((row) => row.kind === 'tool')
      .map((row) => (row.kind === 'tool' ? [row.tool.name, row.tool.failed] : []));
    expect(tools).toEqual([
      ['lookup', true],
      ['spawn_agent', false],
      ['web_search', false],
      ['view_image', false],
      ['clock.sleep', false],
      ['image_gen.generation', true],
    ]);
  });

  it('reads a compaction from the times Codex gave it', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    const started = rollout.now;
    rollout.compact();
    const compaction = read(rollout).rows.find((row) => row.kind === 'compaction');
    expect(compaction).toMatchObject({ kind: 'compaction', start: started });
    expect(compaction?.kind === 'compaction' && compaction.end > started).toBe(true);
  });

  it('reads the error that ended a turn by its kind, never its message', () => {
    const rollout = new Rollout(makeHome());
    for (const info of [
      'usage_limit_exceeded',
      { http_connection_failed: { http_status_code: 502 } },
      null,
    ]) {
      rollout.prompt();
      rollout.complete({ error: info });
    }
    const closes = read(rollout).rows.filter((row) => row.kind === 'turn_complete');
    expect(closes.map((row) => (row.kind === 'turn_complete' ? row.errorType : ''))).toEqual([
      'usage_limit_exceeded',
      'http_connection_failed',
      'ApiError',
    ]);
    expect(JSON.stringify(closes)).not.toContain(SECRETS.error);
  });

  it('reads why a turn was aborted', () => {
    const rollout = new Rollout(makeHome());
    rollout.prompt();
    rollout.abort('budget_limited');
    expect(read(rollout).rows.at(-1)).toMatchObject({
      kind: 'turn_aborted',
      reason: 'budget_limited',
    });
  });

  it('with content off, reads nothing said: no prompt, reply, reasoning, code, command, output or summary', () => {
    const rollout = new Rollout(makeHome());
    rollout.turn(1);
    rollout.prompt();
    rollout
      .reply({ tool: true })
      .edit()
      .mcp('github', 'search')
      .search()
      .toolOutput()
      .compact()
      .abort();
    assertMetadataOnly(JSON.stringify(read(rollout).rows), [rollout.cwd]);
  });

  it('with content on, reads the conversation: the prompt, the reply, its reasoning, the code, the tools’ input and output', () => {
    const rollout = new Rollout(makeHome());
    rollout.turn(1);
    rollout.compact();
    const text = JSON.stringify(read(rollout, true).rows);
    for (const said of [
      SECRETS.prompt,
      SECRETS.reply,
      SECRETS.reasoning,
      SECRETS.code,
      SECRETS.command,
      SECRETS.output,
      SECRETS.lastReply,
      SECRETS.summary,
    ])
      expect(text).toContain(said);
    // Never the instructions Codex hands the model, nor the reasoning it keeps encrypted.
    expect(text).not.toContain(SECRETS.instructions);
    expect(text).not.toContain(SECRETS.encrypted);
  });

  it('from an offset, and never a line Codex is still writing', () => {
    const rollout = new Rollout(makeHome());
    rollout.turn(0);
    const middle = statSync(rollout.path).size;
    rollout.turn(0);
    appendFileSync(rollout.path, '{"timestamp":"2026-11-06T22:10:00.000Z","type":"event_msg","pay');
    const result = read(rollout, false, middle);
    expect(result.rows[0]).toMatchObject({ kind: 'turn_started', offset: middle });
    expect(result.end).toBeLessThan(statSync(rollout.path).size);
    expect(kinds(result.rows).at(-1)).toBe('turn_complete');
  });

  it('is none where it is missing, or a pipe or a folder stands in its place', () => {
    const home = makeHome();
    expect(readRollout(join(home, 'none.jsonl'), { content: false, from: 0 })).toEqual({
      problem: 'no rollout yet',
    });
    const folder = join(home, 'folder.jsonl');
    mkdirSync(folder);
    expect(readRollout(folder, { content: false, from: 0 })).toEqual({
      problem: 'rollout not a file',
    });
    if (process.platform !== 'win32') {
      const fifo = join(home, 'fifo.jsonl');
      mkfifoSync(fifo);
      expect(readRollout(fifo, { content: false, from: 0 })).toEqual({
        problem: 'rollout not a file',
      });
    }
  });
});
