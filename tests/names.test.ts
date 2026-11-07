import { describe, expect, it } from 'vitest';

import { effortOf, mcpToolName, modelOf, providerOf, toolName } from '../src/names.js';

describe('names', () => {
  it('a model as Codex names it, a local one by its file’s name alone', () => {
    expect(modelOf('gpt-6-sol')).toBe('gpt-6-sol');
    expect(modelOf('/home/someone/models/qwen3-coder.gguf')).toBe('qwen3-coder.gguf');
    expect(modelOf('gpt-oss:20b')).toBe('gpt-oss:20b');
    expect(modelOf(undefined)).toBe('unknown');
    expect(modelOf('bad\u0000name')).toBe('unknown');
    expect(modelOf('m'.repeat(200))).toHaveLength(128);
  });

  it('an effort, as a word alone', () => {
    expect(effortOf('xhigh')).toBe('xhigh');
    expect(effortOf('not an effort!')).toBeUndefined();
  });

  it('a provider as the price table names it', () => {
    expect(providerOf('openai')).toBe('openai');
    expect(providerOf('azure')).toBe('azure.ai.openai');
    expect(providerOf('ollama')).toBe('ollama');
    expect(providerOf(undefined)).toBe('openai');
    expect(providerOf('a provider')).toBe('unknown');
  });

  it('a tool as a plain name, an MCP server’s as Codex’s hooks name it', () => {
    expect(toolName('apply_patch')).toBe('apply_patch');
    expect(toolName('rm -rf /')).toBe('unknown');
    expect(mcpToolName('github', 'search_issues')).toBe('mcp__github__search_issues');
    expect(mcpToolName('a server', 'x')).toBe('unknown');
    expect(mcpToolName(undefined, 'x')).toBe('unknown');
  });
});
