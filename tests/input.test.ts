import { describe, expect, it } from 'vitest';

import { handedOff, inputFrom } from '../src/input';

const SESSION = '01a12f57-06f8-7000-8000-010123456789';
const AGENT = '01a12f60-0000-7000-8000-00000000abcd';
const TURN = '01a12f60-1e68-7000-8000-0a0123456789';
const ROOT = '/home/someone/.codex/sessions/2026/10/12/rollout-2026-10-12T08-59-55-01a12f57-06f8-7000-8000-010123456789.jsonl';
const OWN = '/home/someone/.codex/sessions/2026/10/12/rollout-2026-10-12T09-30-00-01a12f60-0000-7000-8000-00000000abcd.jsonl';

describe('a hook’s input', () => {
  it('names a subagent’s own thread and rollout at SubagentStop, never the session’s, and reaches the copy as it was read', () => {
    const subagent = {
      hook_event_name: 'SubagentStop',
      session_id: SESSION,
      agent_id: AGENT,
      transcript_path: ROOT,
      agent_transcript_path: OWN,
      turn_id: TURN,
      model: 'gpt-5.5-codex-mini',
      cwd: '/home/someone/FAKE-project',
      last_assistant_message: 'FAKE reply',
    };
    const input = inputFrom(subagent);
    expect(input).toEqual({ event: 'SubagentStop', sessionId: SESSION, threadId: AGENT, rolloutPath: OWN, turnId: TURN, model: 'gpt-5.5-codex-mini' });
    expect(handedOff(JSON.parse(JSON.stringify(input)))).toEqual(input);
    // A subagent that keeps no rollout of its own has none read, the session's least of all.
    expect(inputFrom({ ...subagent, agent_transcript_path: null })?.rolloutPath).toBeUndefined();
  });

  it('is refused for a rollout Codex has compressed, or one named by a relative path', () => {
    const stop = { hook_event_name: 'Stop', session_id: SESSION, turn_id: TURN };
    expect(inputFrom({ ...stop, transcript_path: `${ROOT}.zst` })).toBeUndefined();
    expect(inputFrom({ ...stop, transcript_path: 'sessions/2026/10/12/rollout.jsonl' })).toBeUndefined();
    expect(inputFrom({ ...stop, transcript_path: ROOT })?.rolloutPath).toBe(ROOT);
  });

  it('is refused without the turn a hook stopped at, but at SessionEnd, which names none', () => {
    const named = { session_id: SESSION, agent_id: AGENT, transcript_path: ROOT, agent_transcript_path: OWN };
    for (const event of ['Stop', 'SubagentStop', 'Interrupt']) expect(inputFrom({ ...named, hook_event_name: event })).toBeUndefined();
    expect(inputFrom({ ...named, hook_event_name: 'SessionEnd' })).toEqual({ event: 'SessionEnd', sessionId: SESSION, threadId: SESSION, rolloutPath: ROOT });
  });
});
