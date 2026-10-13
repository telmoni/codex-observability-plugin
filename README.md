# Telmoni for Codex

Records each turn of your [Codex](https://developers.openai.com/codex) sessions in [Telmoni](https://telmoni.com) as a run: the models it called and their tokens, the tools it used, each with its times and whether it failed. Never a prompt, a reply, a thought, a tool's input or output, a command, a file's path or the folder you work in.

## Install

You need Codex 0.143 or later, git, and Node.js 22 or later with npm on your `PATH`: Codex adds the marketplace with your git, fetches the plugin's npm package with your npm, and the hook runs on your Node.

```sh
codex plugin marketplace add telmoni/codex-observability-plugin --sparse .agents/plugins
codex plugin add telmoni-observability@telmoni-plugins
```

The marketplace is added sparse, so only its manifest is fetched; the plugin itself is the npm package [`telmoni-codex-observability-plugin`](https://www.npmjs.com/package/telmoni-codex-observability-plugin), its built hook alone. Adding it enables it in `~/.codex/config.toml`:

```toml
[plugins."telmoni-observability@telmoni-plugins"]
enabled = true
```

Hooks are on in Codex by default; `hooks = false` under `[features]` is what turns them off.

## Trust its hooks

Codex runs no plugin's hooks until you trust them. Restart Codex, then trust the plugin's four hooks — at `Stop`, `SubagentStop`, `Interrupt` and `SessionEnd` — when Codex says hooks need review, or in `/hooks`. `codex exec` asks nothing: trust them once in Codex itself, which keeps your trust in `config.toml`. An update that changes the hooks asks again.

## Configure

Make a project API key holding the **ingest** scope on your project's API keys page, and keep it in the plugin's own file, readable by you alone:

```sh
touch ~/.codex/telmoni.json && chmod 600 ~/.codex/telmoni.json
```

```json
{ "apiKey": "telmoni_…" }
```

The endpoint defaults to `https://api.telmoni.com`; a self-hosted Telmoni gives its own machine host as `"endpoint"`. `TELMONI_API_KEY` and `TELMONI_ENDPOINT` in Codex's environment — your shell's, or `~/.codex/.env`, which Codex loads itself — come before the file.

Start a new session: Codex reads its hooks and its environment as a session starts.

## What it records

Each turn — from your prompt to Codex's last reply, or to your interruption — is a run of the agent `codex`, and your session is its session, so the console shows a session as a session of traces. Inside the run:

- each response of the model, a model call with its model and its token counts, the cache's among them;
- each tool call — a command, a patch, an MCP tool, a web search — by its name, with its time, failed where Codex says it failed, and cancelled where you declined it or the turn ended first.

A subagent Codex starts runs turns of its own, each a run of the same session. An interrupted turn is a cancelled run, and a turn an error ended a failed one, named by the error's kind (`context_window_exceeded`). A command you run yourself with `!` is no run. In a session Codex keeps in its older, legacy history, a command's exit code is written only into the command's output, which the plugin never reads: there, a command that failed is recorded as run.

A turn is sent once it has ended. If Telmoni cannot be reached, the next turn's hook sends it, and a turn sent twice is stored once.

## When something is wrong

The hook never slows or interrupts a session: it hands its work to a detached process and exits at once, printing nothing. Anything that went wrong is a line in `~/.codex/telmoni/hook.log` (under `CODEX_HOME` where you set one), naming what kind of thing went wrong and never anything from your session.

## Uninstall

```sh
codex plugin remove telmoni-observability@telmoni-plugins
```

Then delete `~/.codex/telmoni/`, the plugin's record of what it sent, and `~/.codex/telmoni.json`, its key.

## License

Apache-2.0
