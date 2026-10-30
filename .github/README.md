# Telmoni for Codex

Records each turn of your [Codex](https://developers.openai.com/codex) sessions in [Telmoni](https://telmoni.com) as a run: the models it called and their tokens, the tools it used, each with its times and whether it failed. Never a prompt, a reply, a thought, a tool's input or output, a command, a file's path or the folder you work in.

## Install

You need Codex 0.143 or later, git, and Node.js 22.23.4, 24.22.1, 26.12.1 or later (October 2026's security releases) with npm on your `PATH`: Codex adds the marketplace with your git, fetches the plugin's npm package with your npm, and the hook runs on your Node.

```sh
codex plugin marketplace add telmoni/codex-observability-plugin
codex plugin add telmoni-observability@telmoni-plugins
```

This repository is the marketplace, and it names the plugin by its npm package, [`@telmoni/codex-observability-plugin`](https://www.npmjs.com/package/@telmoni/codex-observability-plugin): Codex clones the repository for the catalog and fetches the hook as built from npm, never from the clone. Adding the plugin enables it in `~/.codex/config.toml`:

```toml
[plugins."telmoni-observability@telmoni-plugins"]
enabled = true
```

Hooks are on in Codex by default; `hooks = false` under `[features]` is what turns them off.

### From a checkout

Build the plugin:

```sh
git clone https://github.com/telmoni/codex-observability-plugin.git
(cd codex-observability-plugin && npm install && npm run build)
```

Then copy what the package holds — `.codex-plugin/`, `hooks/`, `dist/` and `package.json` — into a folder inside a marketplace of your own, name it there as a local source (`{"source": "local", "path": "./…"}`: Codex takes only a `./` path inside the marketplace's folder), and add the plugin from there (`codex plugin marketplace add ./path/to/marketplace`, then `codex plugin add`). Codex copies a local plugin whole into its cache as it is added, so add it again after each build. Its hooks and its key are then as below.

## Trust its hooks

Codex runs no plugin's hooks until you trust them. Restart Codex, then trust the plugin's four hooks — at `Stop`, `SubagentStop`, `Interrupt` and `SessionEnd` — when Codex says hooks need review, or in `/hooks`. `codex exec` asks nothing: trust them once in Codex itself, which keeps your trust in `config.toml`. An update that changes the hooks asks again.

## Configure

Make a project API key holding the **ingest** scope on your project's API keys page, and keep it in the plugin's own file, `telmoni.json` in Codex's folder (`~/.codex`, or `CODEX_HOME` where you set one), yours and shut to everyone else — the plugin reads it only while it is, and past one it passes over sends nothing, its log saying why:

```sh
touch ~/.codex/telmoni.json && chmod 600 ~/.codex/telmoni.json
```

```json
{ "apiKey": "tm_…" }
```

The endpoint defaults to `https://api.telmoni.com`; a self-hosted Telmoni gives its own machine host as `"endpoint"`. A `TELMONI_API_KEY` in Codex's environment — your shell's, or the `.env` in Codex's folder (`~/.codex/.env`), which Codex loads itself — comes before the file, and goes with the `TELMONI_ENDPOINT` beside it there, or the default, never with the file's: a key is sent only to the endpoint named with it.

A key in the file is read at every hook; one in Codex's environment takes a new session, which reads its hooks and its environment as it starts.

## What it records

Each turn — from your prompt to Codex's last reply, or to your interruption — is a run of the agent `codex`, and your session is its session, so the console shows a session as a session of traces. Inside the run:

- each response of the model, a model call with its model and its token counts, the cache's among them;
- each tool call — a command, a patch, an MCP tool, a web search — by its name, with its time, failed where Codex says it failed, and cancelled where you declined it or the turn ended first.

A subagent Codex starts runs turns of its own, each a run of the same session. An interrupted turn is a cancelled run, and a turn an error ended a failed one, named by the error's kind (`context_window_exceeded`); Codex before 0.145 writes no error at a turn's end, so there such a turn is recorded as one that completed. A command you run yourself with `!` is no run. In a session Codex keeps in its older, legacy history, a command's exit code is written only into the command's output, which the plugin never reads: there, a command that failed is recorded as run. A name longer than Telmoni keeps — a tool's past 145 characters, a model's past 128 — is cut to fit; a turn of any length is recorded whole.

A turn is sent once it has ended: when Codex closes it, which may be minutes after you see its answer while another plugin's hooks run or Codex compacts the session. If Telmoni cannot be reached, the next turn's hook sends it again, as the same bytes, which Telmoni stores once within the hour; what a session's end could not send goes with the next hook of any session.

## When something is wrong

The hook never slows or interrupts a session: it hands its work to a detached process and exits at once, printing nothing. Anything that went wrong is a line in `~/.codex/telmoni/hook.log` (under `CODEX_HOME` where you set one), naming what kind of thing went wrong and never anything from your session.

## Uninstall

```sh
codex plugin remove telmoni-observability@telmoni-plugins
```

Then delete `~/.codex/telmoni/`, the plugin's record of what it sent, and `~/.codex/telmoni.json`, its key, both under `CODEX_HOME` where you set one.

## License

Apache-2.0
