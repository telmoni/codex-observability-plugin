# Telmoni for Codex

Records each turn of your [Codex](https://developers.openai.com/codex) sessions in [Telmoni](https://telmoni.com) as a trace: the models it called and their tokens, the commands, edits and other tools it ran, and the compactions it made, each with its times and whether it failed. Nothing you or the agent said, except the tags you set, unless you turn on **content** and the project keeps content: then each turn's conversation too.

[Telmoni](https://github.com/telmoni/telmoni) is privacy-first, open-source monitoring for AI agents: with your sessions recorded, its [alerts](https://telmoni.com/docs/monitoring/alerts) tell you when a turn fails, loops on one tool or costs more than you set, and show you the turn that did it. Prompts stay in your process unless you turn content on.

## Install

You need Codex 0.167 or later, git, and [Node.js](https://nodejs.org) 22 or later on the `PATH` you start Codex with. The repository is the plugin and its own marketplace:

```sh
codex plugin marketplace add telmoni/codex-observability-plugin
codex plugin add telmoni-observability@telmoni-plugins
```

Codex copies the plugin into `~/.codex/plugins/cache/telmoni-plugins/telmoni-observability/<version>/`. There is nothing to build: the hook runs the bundle committed in `dist/`, which holds the [Telmoni TypeScript SDK](https://github.com/telmoni/telmoni/tree/main/sdk/typescript), built from the core's `sdk/typescript` until the SDK's next release.

**Trust its hooks.** Codex runs no plugin's hooks until you trust them. Start Codex, run `/hooks`, and trust the plugin's `Stop` and `SessionEnd` hooks. Codex ties that trust to every file of the installed plugin, so it asks again after each update. `codex exec` asks nothing: trust the hooks once in Codex itself.

To update, refresh the marketplace and install the plugin again, then trust the hooks again:

```sh
codex plugin marketplace upgrade telmoni-plugins
codex plugin add telmoni-observability@telmoni-plugins
```

## Configure

The plugin needs a [project API key](https://telmoni.com/docs/api/api-keys) that holds the **ingest** scope. Codex gives a plugin's hooks no settings of their own, so the key goes in one of two places.

**A key file**, `~/.codex/telmoni.json`, readable by you alone. Run this, then type `{"apiKey": "tm_…"}`, press Enter, then Ctrl-D. The key never reaches your shell history:

```sh
(umask 077 && cat > ~/.codex/telmoni.json) && chmod 600 ~/.codex/telmoni.json
```

Add `"endpoint"` for a self-hosted Telmoni, which gives its machine host. Where you set `CODEX_HOME`, the file goes in that folder instead. The plugin reads the file only while it is yours and shut to everyone else. If anyone else can read it, the plugin sends nothing and says why in its log.

**Codex's environment**: `TELMONI_API_KEY`, and `TELMONI_ENDPOINT` beside it for a self-hosted Telmoni, in `~/.codex/.env`, which Codex loads as it starts. A key in the environment comes first, and the file is then not read. A key is never sent to an endpoint named somewhere else. One exported in your shell reaches `codex exec`, but not always an interactive session: Codex runs those in a background service that keeps the environment it first started with.

Left blank, the endpoint is `https://api.telmoni.com`. The key file is read as each turn ends, so a change takes effect from the next turn.

### Ask the agent

The plugin brings a skill, `telmoni-observability`, so you can ask Codex in plain words to help connect Telmoni, to tag this repository's runs with its repo and branch, or to work out why your sessions aren't showing up. The skill never asks for your key or reads the key file: it tells you what to run in your own terminal.

### A turn's conversation

**Content** is off unless you turn it on: `"captureContent": true` in the key file, or `TELMONI_CAPTURE_CONTENT=1` beside a key in the environment. With it on, each turn carries its conversation too:

- your prompt, without the instructions Codex hands the model;
- each reply, with the reasoning summaries Codex writes;
- the code each model call ran through Codex's `exec` tool;
- each command, edit and tool call's input and output;
- each compaction's summary.

Telmoni keeps it only in a project whose [content mode](https://telmoni.com/docs/workspace/organizations-and-projects#a-projects-content-mode) is on. For any other project, nothing of the conversation leaves your machine.

**Scrubbing secrets** and **personal data** are on unless you turn them off: `"scrubSecrets": false` or `"scrubPii": false` in the key file, or `TELMONI_SCRUB_SECRETS=0` or `TELMONI_SCRUB_PII=0` beside a key in the environment. Before content leaves, each match is replaced with a marker such as `[secret: aws_key]` or `[pii: email]`:

- secrets: keys, tokens, passwords, private keys and connection strings;
- personal data: emails, phone numbers, card numbers, IP addresses and home folders' paths.

No pattern finds a name or a street address.

## What a turn records

A turn, from your prompt to Codex's last reply, is one trace of the agent `codex`, released as the Codex version that ran it. Your session is the trace's session, so the console groups a session's traces together. Inside the trace:

- **Model calls.** One per model response, from what it was handed (your prompt, or the tools' output) to its end. Each names the turn's model and its reasoning effort, and has its input, output, cache-read and cache-write tokens as Codex counts them. The provider is the one Codex names (`openai`, `ollama`), its `azure` as Azure OpenAI.
- **Tool calls.** What Codex ran, by kind: `shell` for a command, `apply_patch` for an edit, `web_search`, `view_image`, `image_generation`, an MCP server's tool as `mcp__<server>__<tool>`, a dynamic or subagent tool by its name (`spawn_agent`, `wait`), and Codex's own extensions by their kind (`clock.sleep`), each with the times Codex wrote. A command that exited non-zero, or a call Codex marked failed, is failed; an edit you refused is cancelled. A command you run yourself (`!cmd`) is not the agent's, and not recorded. Where the model runs its tools through Codex's `exec` tool, as it writes code to, that code is content: the run holds what the code did.
- **Errors.** The error that ended a turn is its last model call, failed, named by Codex's kind for it (`usage_limit_exceeded`, `response_too_many_failed_attempts`), never its message: Codex writes no record of a request that failed.
- **Compactions.** Each is a step named `compaction`, holding the model call that wrote its summary.

A turn you interrupt is a cancelled trace, as is one still open when the session ends. A turn an error ended is a failed one, and one that ran out of Codex's budget fails as `budget_limited`.

A turn is sent once Codex has closed it, which Codex does just after the turn's `Stop` hook returns: the hook's worker waits for it, 30 s at most. A turn that an error ended or that you interrupted fires no `Stop`, so it is sent at the next turn's end, or when the session ends. The first turn the plugin hears end in a session is the first it records: turns from before the plugin was installed, or before a key was set, stay on your machine. A session Codex keeps no rollout of (`codex exec --ephemeral`) is not recorded.

A subagent Codex starts works in a thread of its own, whose model calls are not in the trace: the trace holds the tool calls that started it and waited on it.

With content off, the plugin reads only:

- each line's kind and time, and the turn it belongs to;
- each model response's tokens, the turn's model and effort, and the session's provider and Codex's version;
- each tool call's kind, times and status, a command's exit code, and an MCP tool's server and name;
- an error's kind;
- of what its hook is handed, the session's id, the rollout's path, the turn's id and the model's name, and the session's folder, only to find the tags file above it.

It never keeps or sends your prompt, a reply, the reasoning, the code the model ran, a command, a tool's input or output, a file's path or contents, the folder you work in, the rollout's path, a compaction's summary or an error's message. With content on, it sends the conversation above, and still never the folder you work in or the rollout's path, beyond what the conversation itself holds, a tool's output among it.

## Tags

A `.telmoni-tags.json` in the folder you start Codex in, or the nearest folder above it, labels every turn of the session, for example `{"repo": "telmoni", "branch": "main"}`.

- The file is read for its tags alone, never through a link, and its path is never sent.
- A key is 1 to 64 letters, digits, `_`, `.` or `-`, and a value up to 256 characters.
- A turn carries 32 tags at most.

A tag that breaks a rule is dropped with a line in the log, and the turn is sent without it. Tags are metadata: they are sent in every content mode and everyone on the project can see them, so a secret or a personal detail never belongs in one.

## When nothing shows up

The hook runs as each turn ends and hands the work to a process of its own, so no turn waits on Telmoni. Its log is `hook.log` in the data folder Codex gives the plugin, `~/.codex/plugins/data/telmoni-observability-telmoni-plugins/`. Each line names a session by the start of its id, never anything said in it, and says one of:

- a turn sent;
- no key;
- a key file passed over, and why;
- an endpoint the SDK refused;
- a turn held because Codex had not closed it yet;
- a turn Telmoni could not take, which is kept and sent again at the next turn's end;
- a turn it refused for good.

Kept turns are capped at the newest 200 a session.

If the log is missing, check that `/hooks` in Codex shows the plugin's hooks trusted, that `node --version` prints 22 or later in the shell you start Codex from, and that `codex plugin list` shows the plugin installed.

To remove the plugin, run `codex plugin remove telmoni-observability@telmoni-plugins`, then delete `~/.codex/telmoni.json` and `~/.codex/plugins/data/telmoni-observability-telmoni-plugins/`.

## Developing

[ARCHITECTURE.md](ARCHITECTURE.md) says how the plugin works, and how to build and test it from a checkout. To contribute, start with Telmoni's [contributing guide](https://telmoni.com/docs/contributing/introduction). At `0.0.0` nothing is released.

## License

Apache-2.0.
