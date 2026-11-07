/**
 * What a record may call a model, a provider or a tool: a plain name within ingest's caps, never text a model wrote by
 * mistake.
 */

/** A control character, or half of a character, which no name holds. */
const NOT_TEXT = /[\u0000-\u001f\u007f-\u009f]|\p{Cs}/u;
const MODEL_MAX = 128;
const PLAIN = /^[A-Za-z0-9_.:@+-]+$/;
const TOOL_MAX = 145;
const EFFORT = /^[a-z][a-z_-]{0,31}$/;

/** The model Codex names, or `unknown` for anything no model's name holds. */
export function modelOf(given: string | undefined): string {
  if (given === undefined || given.trim() === '' || NOT_TEXT.test(given)) return 'unknown';
  // A path is no model's name, and may hold a person's folders: a local model is sent by its file's name alone.
  const named = given.trim().split(/[\\/]/).at(-1) ?? '';
  return named === '' ? 'unknown' : named.slice(0, MODEL_MAX);
}

/** How hard the model was asked to reason (`low`, `high`, `xhigh`), which is metadata, sent in every mode. */
export function effortOf(given: string | undefined): string | undefined {
  return given !== undefined && EFFORT.test(given) ? given : undefined;
}

/**
 * The provider as the price table names it: Codex's `azure` serves OpenAI's models through Azure OpenAI, and every
 * other provider goes by the id Codex gives it (`openai`, `ollama`), or as `unknown` where that is no plain name.
 */
export function providerOf(given: string | undefined): string {
  if (given === undefined || given === '') return 'openai';
  if (given === 'azure') return 'azure.ai.openai';
  return PLAIN.test(given) ? given.slice(0, 64) : 'unknown';
}

/** A tool's name, or `unknown` for one holding anything a tool's name does not. */
export function toolName(given: string | undefined): string {
  return given !== undefined && PLAIN.test(given) ? given.slice(0, TOOL_MAX) : 'unknown';
}

/** An MCP tool as Codex's hooks name it, `mcp__<server>__<tool>`. */
export function mcpToolName(server: string | undefined, tool: string | undefined): string {
  return toolName(server && tool ? `mcp__${server}__${tool}` : undefined);
}
