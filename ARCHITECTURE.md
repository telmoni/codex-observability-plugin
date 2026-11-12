# Architecture

The Codex plugin for Telmoni: a `Stop` and `SessionEnd` hook that records each turn of a person's Codex sessions as a trace, metadata only unless the person turns content on, through the platform's TypeScript SDK ([`telmoni/telmoni`](https://github.com/telmoni/telmoni), `sdk/typescript`). The repository is the plugin and its own marketplace: Codex installs it from its address or from a clone, and runs the hook from the copy. The bundle in `dist/` is committed, since Codex builds nothing.

## Purpose and scope

The plugin records one trace per turn, from the person's prompt to Codex's close of the turn, of the agent `codex`, in the session Codex names. A trace holds:

- its model calls, one per model response, with their tokens;
- its tool calls: the commands, edits, MCP tools, web searches and image views Codex ran;
- its errors, as failed model calls;
- its compactions;
- the tags of its folder;

each with its times and whether it failed or was cancelled.

The plugin reads Codex's own rollout after the fact. It adds no tool and no rule, and it never fails or slows a turn. Its one skill, whose full text Codex loads only when a prompt calls for it, tells the agent how to connect, tag and troubleshoot the plugin. What becomes of a trace past ingest is Telmoni's.

## How Codex loads it

Checked against Codex 0.167.0's source (tag `rust-v0.167.0`), the rollouts it writes (their keys and kinds, never their content) and an install into a Codex folder of its own; no hook has yet run in a live session.

- **The manifest**, `.codex-plugin/plugin.json`. Codex looks for a plugin's manifest at a root `plugin.json` that declares the Agent Plugins 1.0 schema, then `.codex-plugin/`, `.claude-plugin/` and `.cursor-plugin/plugin.json`, in that order. It holds:
  - the name `telmoni-observability`, the version and the description;
  - `skills`, `./skills/`;
  - `interface`, the page Codex shows: the names, the category `Developer Tools`, three prompts at most of 128 characters each, the brand colour (`#F2A93B`, the logo's amber unit) and the logo, `assets/logo.png`, the Antigravity plugin's.

  It names no `hooks`: an explicit value would replace the default `hooks/hooks.json`, not add to it. It names no settings either, since Codex has none for a plugin.
- **The marketplace**, `.agents/plugins/marketplace.json`, `telmoni-plugins`, whose one plugin's source is `./`, the marketplace's own root. Codex reads a marketplace there, or at `.claude-plugin/marketplace.json`. `codex plugin marketplace add telmoni/codex-observability-plugin` clones the repository; `codex plugin add telmoni-observability@telmoni-plugins` copies the plugin into `~/.codex/plugins/cache/telmoni-plugins/telmoni-observability/<version>/` and enables it in `~/.codex/config.toml`.
- **The hooks**, `hooks/hooks.json`, in the shape Claude Code's takes: `Stop` and `SessionEnd`, each one `command` handler, `node "${PLUGIN_ROOT}/dist/hook.mjs" || true`, with `commandWindows`, `node "%PLUGIN_ROOT%\dist\hook.mjs" || exit /b 0`, for `cmd`.
  - Codex runs a hook's command through the session's shell, `<shell> -c` (`$SHELL -lc` where it resolves none, `%COMSPEC% /C` on Windows), unsandboxed, in the session's working folder, the payload on stdin, in a process group of its own, which it kills at the hook's timeout. It waits for the command to exit and for its stdout and stderr to close.
  - The command's environment is the one the process hosting the session had as the session began, less six variables Codex keeps to itself, with `PLUGIN_ROOT`, the installed copy, and `PLUGIN_DATA`, `~/.codex/plugins/data/telmoni-observability-telmoni-plugins/`, beside them (and `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`, for Claude Code's plugins). `shell_environment_policy` is not applied to it. Every Codex process loads `$CODEX_HOME/.env` as it starts. The interactive TUI runs its sessions in a background service it starts and shares, so their hooks have the environment of the `codex` that started it; `codex exec` runs its session in its own process.
  - `Stop`'s timeout is 10 s. `SessionEnd`'s is 3 s, the most Codex allows it; its default is 1 s.
  - A `Stop` hook's plain output is invalid to Codex, and exit code 2 would keep the turn going: the hook prints nothing and exits 0.
  - `Stop` fires when a root session's turn ends with no more for the model to do, before Codex closes the turn. A turn an error ended, one interrupted (`Interrupt` fires instead), a `!cmd`, a `/compact` or a `/review` fires none, nor does a subagent's thread (`SubagentStop` fires instead) or a guardian reviewer's. `SessionEnd` fires as a root session ends, once its turns are closed and its rollout flushed.
- **Trust.** Codex runs no plugin's hook until the person trusts it, in `/hooks`. The trust is a digest of every file in the installed plugin, so every update asks for it again, and the plugin never writes inside its own folder. `codex exec` asks nothing: hooks trusted in Codex run there too.
- **The skill**, `skills/telmoni-observability/SKILL.md`. It covers connecting the key, trusting the hooks, the content and scrubbing switches, writing `.telmoni-tags.json`, and reading `hook.log`, and runs nothing of the plugin's.
  - It forbids the agent to ask for a key, take one in the chat, put one in a command, or open the key file. The person sets the key in their own terminal, by a command that keeps it out of the shell's history.
  - It has the agent tag a repository by its name alone, never its remote's URL, which can hold a token.
- **The directory.** A plugin that bundles hooks cannot be listed in OpenAI's public plugin directory: it is installed from this repository alone.

## Processes: the hook and its worker

`dist/hook.mjs` (`src/cli/hook.ts`) loads no SDK: it imports none, so its file holds only the payload, the paths and the state helpers.

1. It reads stdin, 64 MiB at most, since the payload carries the last reply.
2. It keeps what `payload.ts` reads (below), and stamps the stop with the time the hook ran and the rollout's size as it finds it (a `stat`, nothing read).
3. It starts `dist/worker.mjs` with Node's own executable (`process.execPath`): detached, in a session of its own (`windowsHide` on Windows), out of the hook's process group, which Codex kills at the hook's timeout. Its stdout goes nowhere and its stderr to the log, never the hook's own, which Codex waits to see closed. Its working folder is the plugin's data folder, never the plugin's own.
4. It hands the stop over on the worker's stdin, never as an argument, which others on the machine can read, and waits for the pipe to take it, 2 s at most.
5. It exits 0, printing nothing.

Any fault is swallowed: the hook exits 0 whatever it meets.

The worker (`src/worker.ts`) resolves the settings, then takes the session's lock and reads its state. It reads the rollout from the state's offset once it has stayed still for 0.5 s and holds the stopped turn's close, waiting 30 s at most: Codex closes a turn only after its `Stop` hooks return, and after a compaction it may run at the turn's end. It sends each turn that can no longer change, and keeps the rest. If nothing of its own is left kept, it sends what other sessions left. It exits 0 whatever happens; a fault is one line in the log naming its type.

## What it reads

**The payload** (`payload.ts`). Of Codex's `Stop` and `SessionEnd` payloads, the plugin keeps:

- `hook_event_name`, `Stop` or `SessionEnd`, else nothing is done;
- `session_id`, a plain id (`[A-Za-z0-9_-]{1,128}`), else nothing is done;
- `transcript_path`, absolute and ending in `.jsonl`, else nothing is done: Codex names none for a session it keeps no rollout of, an ephemeral one;
- `turn_id`, of a `Stop`, a plain id;
- `cwd`, where absolute, only to find the tags file;
- `model`, up to 256 characters.

It never reads `last_assistant_message`, `permission_mode` or `stop_hook_active`.

**The rollout** (`transcript.ts`), `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session>.jsonl`: a JSON object a line, `{timestamp, ordinal, type, payload}`, appended as the session goes.

- It is opened without blocking and checked to be a file, so a pipe in its place cannot hold the worker.
- It is read from the state's offset to the last line ended, 256 MiB at most: a line Codex is still writing is left for the next read.
- A line that is not a JSON object with a type and an object for a payload is passed over.
- Its first line, `session_meta`, is read for Codex's version (`cli_version`) and the provider (`model_provider`).

Of each line the plugin reads its `timestamp`, to the millisecond, and the turn it names (`payload.turn_id`, or a response item's `internal_chat_message_metadata_passthrough.turn_id`), and of:

- `event_msg` `task_started`: a turn's opening;
- `turn_context`: the turn's `model` and `effort`;
- `event_msg` `thread_settings_applied`: the session's `model`, `model_provider_id` and `reasoning_effort`, for a turn whose context names none;
- `token_usage_record`: a model response's `usage`, `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` and `reasoning_output_tokens`, the last a subset of output, omitted where unreported;
- `event_msg` `item_completed`, the item's `type`, `status`, `started_at_ms` and `completed_at_ms`:
  - a `CommandExecution`, its `exit_code`, and its `source`, to pass over a command the person ran (`user_shell`);
  - a `FileChange`; an `McpToolCall`, its `server`, `tool` and whether it has an `error`; a `DynamicToolCall`, its `tool` and `success`; a `CollabAgentToolCall`, its `tool`; a `WebSearch`; an `ImageView`; an `ImageGeneration`; an `Extension`, its `kind` and whether it has a `failure`;
  - a `ContextCompaction`, a compaction's times;
  - a `UserMessage`, the prompt's place;
- `response_item` `custom_tool_call_output` and `function_call_output`: a tool's output handed back to the model, by its place alone;
- `compacted`: a compaction's summary, by its place alone;
- `event_msg` `task_complete` and `turn_aborted`: a turn's close, an abort's `reason`, and the kind of the `error` either names, its `codex_error_info`, never its `message`.

Codex 0.167 writes no record of an error of its own, nor of a request that failed: the error that ended a turn is in its close alone.

**With content on**, it also reads:

- a `UserMessage`'s text parts, the prompt as typed, never the instructions and context Codex hands the model as `developer` and `user` messages before it, nor its images, files or mentions;
- an assistant `message`'s text, a `reasoning` item's `summary`, never its `encrypted_content`, and a `custom_tool_call` or `function_call` with its `input` or `arguments`, the code the model ran through `exec`;
- a tool's output as the model was handed it;
- a `CommandExecution`'s `command` and `aggregated_output`, a `FileChange`'s `changes` and output, an `McpToolCall`'s or a `DynamicToolCall`'s `arguments` and result, a `CollabAgentToolCall`'s `prompt` and its agents' states, a web search's `query` and `results`, an image generation's revised prompt;
- a compaction's `message`, and `task_complete`'s `last_agent_message`.

It never reads an image a prompt carries. With content off, none of the above is read.

## How turns are cut

`turns.ts`. A `task_started` opens a turn, and its `task_complete` or `turn_aborted` closes it. A line naming a turn belongs to it; one naming none, to the turn it was written in. Nothing written after a turn's close is its own, and lines before the first turn belong to none. Within a turn, as `record.ts` reads it:

- **Model calls.** Each `token_usage_record` is one model response, which runs from what it was handed, the prompt or the tools' last output (or the response before it), to its record. Its tokens are counted as Codex counts them, which is as the conventions do: the input with the cache's reads and writes, the output with the reasoning.
- **Tool calls.** Each `item_completed` of a tool's kind is one call, at the times Codex wrote: `shell` for a command, `apply_patch` for an edit, `mcp__<server>__<tool>`, `web_search` and `view_image`.
  - A call fails as `ToolError` where Codex marked it `failed`, or a command exited non-zero.
  - A call whose status is `declined`, an edit refused by the person, is cancelled.
  - The `exec` tool the model calls is not a call of its own: what its code ran is.
  - A dynamic or subagent tool goes by its name (`spawn_agent`, `wait`), an extension by its kind (`clock.sleep`).
- **Errors.** The error that ended a turn is its last model call, failed, from what that call was handed to the close, named by Codex's kind for it (`usage_limit_exceeded`, `response_too_many_failed_attempts`), else `ApiError`.
- **Compactions.** Each `ContextCompaction` is a step named `compaction`, at the times Codex gave it, holding the model calls that ended within them: the summary's own. Its summary is the `compacted` line's.

A turn is complete, and sent, when nothing can still change it:

- Codex closed it; or
- a later turn began; or
- the session ended: a `SessionEnd` hook's worker sends every turn still open, as cancelled.

A `Stop`'s worker waits for the stopped turn's close, which Codex writes only once its `Stop` hooks have returned. A turn that fires no `Stop`, one an error ended or one interrupted, is sent at the next hook, a later turn's `Stop` or the session's end. A turn not complete holds every turn after it, and the log says `held <trace id>` at each hook that holds it, where the turn had begun before that hook ran: one begun after it is at work, as it should be.

A turn with no call in it is not recorded.

**Where a session starts.** The state's offset is where the first turn not yet done with begins. A session first heard of starts at the turn that stop ended, so its history from before the plugin, or before a key, is never sent; one first heard of at its end starts at the rollout's end.

## What it sends

One trace a turn, built by `record.ts` as the SDK's `TraceRecord`, which is also what the state keeps, with the Codex version it is released as, and sent through `recordTrace`.

- **Ids.** The trace's id is the version 5 UUID of `<session>:<turn>`, under the plugin's own namespace, `uuid5(NAMESPACE_URL, "https://telmoni.com/codex-observability-plugin")`, spelled as its 32 hex digits: a turn recorded while the id was written as a UUID keeps it. The SDK makes each span's id from it and the span's place, so a turn sent twice is stored once. The worker also remembers the newest 500 ids it sent, and passes over a turn among them.
- **The trace.**
  - It is a trace of the agent `codex`, in the session, from the turn's start to its last time, released as the session's `cli_version`.
  - It fails by the kind of the error that ended it, and as `budget_limited` where Codex aborted it for its budget.
  - It is cancelled where Codex aborted it otherwise (`interrupted`, `replaced`, `review_ended`), or where it never closed it before the session ended or another turn began.
  - It carries the tags of the session folder's `.telmoni-tags.json`.
- **Model calls.** Each names the turn's model, its reasoning effort as metadata, and its provider: Codex's `azure` as `azure.ai.openai`, any other by Codex's id (`openai`, `ollama`). A model named by a path goes by its file's name alone, and one holding a control character as `unknown`.
- **Tool calls** by name. A name holding anything but letters, digits and `_.:@+-` goes as `unknown`.

Every call is ordered by its start.

**With content on**:

- the trace's input is the prompt as typed, and its output the turn's last reply;
- each model call carries what is new to it: the turn's first is handed the prompt, each later one the tools' output since the call before, as one `tool` message of `tool_call_response` parts;
- each model call's output is its reasoning summary, its words and its tool calls with their input;
- each tool call carries its input and its output;
- each compaction carries its summary, as its output.

The SDK sends content only where the project's content mode is `on`, and scrubs it first unless a switch says otherwise.

## Configuration

The worker reads the settings at every hook (`shared/settings.ts`).

- **The key.** `TELMONI_API_KEY` in the hook's environment comes first. Beside it, `TELMONI_ENDPOINT`, `TELMONI_CAPTURE_CONTENT` (on at `1` alone), and `TELMONI_SCRUB_SECRETS` and `TELMONI_SCRUB_PII` (off at `0` alone), each with Unicode's White_Space trimmed. `$CODEX_HOME/.env` is the place for them that reaches every session's hooks: one exported in a shell reaches an interactive session's only where that shell started the service Codex runs it in.
- **The key file.** Else `telmoni.json` in Codex's folder, `CODEX_HOME` where it names an absolute one, else `~/.codex`: `apiKey`, `endpoint`, `captureContent`, `scrubSecrets` and `scrubPii`.
  - It is read only while it is a regular file, the person's own, with no bit of `077`, at most 64 KiB, and a JSON object.
  - It is opened without blocking.
  - A field there but empty, or a switch neither `true` nor `false`, has the whole file passed over, logged once a session, and nothing is sent.
- **Pairing.** A key never goes to an endpoint, nor takes a switch, named anywhere but beside it.
- **Where it lives.** Codex gives a plugin's hooks no settings, so the file sits in Codex's own folder, beside its `auth.json`, out of every repository.
- **The endpoint.** A self-hosted Telmoni's machine host, beside the key. There is no default: without one, as without a key, the worker logs once a session that there is none (`worker.ts`), and sends nothing; the bundled SDK's own default is never reached. The SDK's `Config` checks it. One it refuses is logged once a session, in the SDK's words, which name at most the host, and the turns wait for it to be fixed.

## State and the log

The plugin's folder is `PLUGIN_DATA`, the data folder Codex gives the plugin's hooks, which an update leaves alone; where a hook runs without one, as one wired in by hand does, it is `telmoni/` in Codex's folder. It is made or closed to its owner (0700), and every file in it is 0600. In it:

- `<session>.json`, the session's state:
  - `offset`, where in the rollout the first turn not yet done with begins;
  - `sent`, the newest 500 trace ids;
  - `pending`, the traces Telmoni could not take yet, each under `trace` with the Codex version it goes as and its conversation where content is on, the newest 200; an entry of another shape is passed over;
  - `warned`, the once-a-session lines;
  - `destination`, an HMAC of the endpoint under the key, its first 16 hex digits.

  It is written whole to `<session>.json.<pid>.tmp`, synced and renamed over the last, after each trace sent or kept and at the end. A state that cannot be read is left as it is: the session sends nothing until it is fixed or moved aside, since read as new it would lose its kept traces.
- `<session>.pending`, beside a state that still holds traces, made once, so the longest waiting goes first, and any hook finds them without reading every state.
- `<session>.lock`, the worker's while it works on the session (`shared/state.ts`'s `withLock`). It holds a token of the worker's own, and is freshened every 10 s; one not freshened for a minute was left by a worker that died. A stop's worker waits a minute for the lock, then logs that another hook holds the session and leaves its turns to the next.
- `hook.log`, a line `<UTC time> <session> <text>` for each trace sent, taken in part, refused or kept, each turn held, each once-a-session warning, each tag dropped and each fault. The worker's stderr goes there too. Past a mebibyte it is moved aside to `hook.log.1`.

Nothing of the session is logged: a session is named by the first 8 characters of its id, and a trace by the first 8 of its.

## Delivery and failure

`shared/send.ts`: a client a trace, so the SDK's once-per-client warnings are the trace's. Its queue has no bound, and a flush waits as long as the SDK's own attempts take. The verdict is read from each warning's kind, status and problem type, never its words:

- **Kept, sent again.** A network failure, a timed-out flush, or a refusal with a status that is not final, such as `401`, `403`, `404`, `429`, a `5xx` other than `500`, or a `500` for ingest's database.
- **Refused for good**, logged and remembered as sent. A refusal at `400` or `413` for what the trace holds, `402` for the organization's standing, or `500` for a fault of Telmoni's own; and a trace the SDK itself refuses, which includes a kept trace that no longer builds.
- **Taken in part**, logged: a span or a field dropped.

A session's kept traces go before its new ones, in order: a turn queues behind a kept trace unsent.

A session that ends while it still holds traces has no next stop of its own. So the next stop of any session that holds none of its own sends what the others left, the longest waiting first:

- each under that session's lock, taken without waiting;
- only where its `destination` is the same, so traces go nowhere their own key did not send them;
- stopping at the first Telmoni still cannot take.

Past 200 kept traces the oldest go, and the log says how many. A key or endpoint changed under a session drops what it kept for the old one, logged. A kept record in a shape the plugin does not send is dropped as the state is read, and the log says how many.

## Shared code

`src/shared/` holds copies of the SDK's coding-agent module (`telmoni/telmoni` `sdk/typescript/src/coding-agent/` at `95db29c9`): `settings`, `log`, `state`, `send` and `tags`. They are the Antigravity plugin's copies, byte for byte, changed from the SDK's only in their imports and Prettier's line width. The SDK does not export the module yet; once it does, the copies go and the plugin imports it.

## Build and the SDK

`tsup` (`tsup.config.ts`) bundles two entries, `src/cli/hook.ts` and `src/cli/worker.ts`, into `dist/` as two self-contained ESM files for Node 22, `hook.mjs` and `worker.mjs`, every dependency inside, unminified. It is the other Telmoni plugins' build, with this repository's entries; Vitest runs on its defaults, with no config file.

The build is unsplit (`splitting: false`): splitting writes a file for every dynamic import esbuild meets, OpenTelemetry's machine-id detectors among them, and nothing ever loads them. The hook holds no SDK without splitting, since it imports none. `manifest.test.ts` holds `dist/` to those two files and the hook to no SDK. `.gitattributes` marks `dist/` generated (`-diff linguist-generated=true`): `git diff` and GitHub's pull requests show its files as changed, not line by line, and CI's comparison fails on any difference all the same.

The SDK is a development dependency, `file:../telmoni/sdk/typescript`, a checkout of the core beside this one. The published `telmoni` 0.2.0 has no structured warnings, no content messages, no scrubbers and no steps inside steps. Once the SDK's next release is on npm, the dependency becomes its version range. The lockfile is the Antigravity plugin's, renamed, so the three plugins build with the same tools.

## Testing

From a checkout, with the core cloned beside it for the SDK until its next release is on npm:

```sh
git clone https://github.com/telmoni/telmoni.git
git clone https://github.com/telmoni/codex-observability-plugin.git
(cd telmoni/sdk/typescript && npm ci && npm run build)
cd codex-observability-plugin && npm ci
npm run verify     # format check, type-check, build, tests
npm run validate   # a Codex installs the plugin from this checkout
npm run format     # Prettier, as the format check wants it
```

`npm run verify` runs Prettier's check (`.prettierrc.json`, the other plugins' own), the type-check, the build and the suite (vitest). It needs no network once the core's SDK is built. Codex has no validator for a plugin, so `npm run validate` runs `tests/install.test.ts`: a `codex` on the `PATH`, or the one `CODEX_BIN` names, adds a copy of the checkout as a marketplace and installs the plugin from it, in a Codex folder of the test's own, and the test checks what the install copied and enabled. `npm test` runs it too where it finds a `codex`, and skips it where it finds none; `npm run validate` fails without one.

`dist/` is committed, since Codex builds nothing when it installs a plugin: it goes in with the change that rebuilt it.

`tests/helpers.ts` holds the fixtures, all synthetic, never a recorded session:

- `Rollout` writes a session's lines as Codex 0.167 writes them: the session's first line, a turn's opening with the instructions and context Codex hands the model, the prompt, responses with their reasoning, words, `exec` calls and tokens' records, commands, edits, MCP tools, web searches and any other item, the tools' output, compactions with their own model call, and a turn's close, with the error that ended it, or its abort.
- `stopPayload` and `endPayload` are Codex's `Stop` and `SessionEnd` payloads, the last reply in the first.
- `FakeTelmoni`, given to the SDK as its transport, answers each export as told, names a content mode, and goes offline on request.
- `SECRETS` are marked phrases planted wherever a session says something or names a place. `assertMetadataOnly` fails on any of them, or the key, in what is sent, kept or logged.

Each suite proves its module:

- `payload.test.ts`: what is kept of a stop, and the hand-off to the worker;
- `transcript.test.ts`: each field read, the session's first line, tokens, each tool's kind and failure, a command the person ran passed over, a compaction's times, the kind of the error that ended a turn and why one was aborted, content only when asked, an offset and a line half written, and a pipe or a folder in the rollout's place;
- `turns.test.ts`: how turns are cut, and when one is complete;
- `names.test.ts`: models, efforts, providers and tools;
- `record.test.ts`: a turn as a trace, with its times, model calls, tokens, tools, failures, errors, compactions, outcomes and ids, and with content off and on;
- `worker.test.ts`: the worker end to end, the SDK included. It covers:
  - delivery, once a turn;
  - waiting for the close Codex writes after the hook, holding a turn not closed, and the session's end;
  - where a session starts, and the offset it keeps;
  - kept, refused and left traces;
  - the key, the key file, `CODEX_HOME` and the environment;
  - tags, and `PLUGIN_DATA`;
  - an unreadable state and a lock held;
  - content only under both switches;
- `hook.test.ts`: the built hook, run as Codex runs it, its command from `hooks.json` through the shell with `PLUGIN_ROOT` set. It prints nothing and exits 0 on anything, even with no `node`, returns before its worker, and its worker sends to a Telmoni on this machine;
- `manifest.test.ts`: the versions agree, the manifest's names, skills and page, the marketplace, the hooks and their commands, the skill named as its folder, and the bundle's two files;
- `install.test.ts`: Codex installs the plugin (above).

CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request:

- it checks out the core at a pinned commit beside this repository and builds its SDK;
- it runs the format check, the type-check, the build and a check that the committed `dist/` is what the build makes, on Node 22.23.4 and 26.13.0, the pins the other plugins use;
- it runs the suite, then installs `@openai/codex` at the version `CODEX_VERSION` pins and runs `npm run validate`;
- it checks the workflows under actionlint.

## Release

Everything an install needs is in the repository: the manifest, the marketplace, the hooks, `dist/`, the skill and the logo. Codex names an installed plugin's folder by its manifest's version.

A release is the version bumped in `.codex-plugin/plugin.json` and `package.json` in one commit on `main`; `manifest.test.ts` fails where they differ. On that push, `.github/workflows/release.yml`:

1. checks that the two agree on a plain `X.Y.Z`;
2. asks GitHub whether tag `v<version>` and its release exist;
3. for a new version, waits for CI's run on the commit to pass;
4. once the owner approves the `release` environment, makes the tag through the API and cuts the GitHub release.

Every other push ends green with nothing done, as does every push while the version is `0.0.0`, which is unreleased: nothing is tagged or asked for until it is bumped.

## Decisions

- **TypeScript, bundled, `dist/` committed**, as for the other Telmoni plugins. Codex copies a plugin as it finds it and builds nothing; Node runs the bundle on every platform, through `sh` and through `cmd`. The cost: Node 22 or later on the `PATH`.
- **`.codex-plugin/plugin.json`, not a root `plugin.json`.** It is the other plugins' layout, a dot-folder of the host's own, and what OpenAI's own plugins ship. The Agent Plugins format would put the hooks under `extensions["com.openai"]` all the same, and a plugin with hooks is no candidate for the public directory.
- **The rollout, not the hooks, as the source.** Only `Stop` and `SessionEnd` are registered. `PostModelRequest` and `PostToolUse` would each start a shell and Node at every model call and tool, which the turn waits on, or, made `async`, be cancelled with the session. The rollout holds every response's tokens and every tool's times. The cost: reading a format Codex owns and moves.
- **What the code did, not the `exec` that ran it.** The model calls one `exec` tool with code; its commands, edits and tools are each an `item_completed` with its own times and status.
- **A detached worker.** Codex waits on a hook, and kills it at its timeout: 1 s for `SessionEnd` unless told otherwise. The sending, which may wait on a slow Telmoni, happens in a session of its own, where nothing waits on it. The cost: the session never hears how a send went; the log alone says.
- **`SessionEnd` as well as `Stop`**, so a session's last turn, one an error ended or one interrupted, which fire no `Stop` of their own, and one closed after its `Stop`'s worker gave up waiting, are sent when the session ends, not at a session that may never come.
- **Not `Interrupt` nor `SubagentStop`.** An interrupted turn is sent at the next hook, with the abort Codex writes only after `Interrupt`'s hooks return. A subagent's thread would be its own rollout to read and nest; that is a change of its own.
- **A key file in Codex's folder.** Codex offers a plugin's hooks no settings, and an interactive session's hooks have the environment of the service Codex started for it, which may be older than the shell's. The file follows the Antigravity plugin's: the person's own, shut to everyone else, in the host's own folder.
- **`PLUGIN_DATA` for the state**, the folder Codex gives a plugin's hooks for it, which an update leaves alone and the trust digest leaves out.
- **History stays home.** A session first heard of is recorded from the turn that stop ended, so installing the plugin, or setting a key, never sends the past.
- **A skill for the page's prompts.** Codex shows up to three starter prompts; a plugin of hooks alone gives the agent nothing to act on for them, so the skill teaches it the plugin: what it can do for the person (a tags file, reading the log) and what it must leave to them (the key, the hooks' trust).

## Known gaps

- No hook of the plugin's has run in a live Codex session: the payloads, the trust and the shell are from Codex's source and docs. Windows is untried.
- A moved rollout format is not detected. It shows as traces with less in them, or turns held, until the reader catches up. The reader is written for Codex 0.167's.
- A model call's start is where the rollout says it was handed its input, not when Codex sent the request.
- A tool Codex writes no `item_completed` for (`update_plan`, `request_user_input`, `write_stdin`, a tool interrupted, an `exec_command` refused) is not recorded as a call: what the model asked of it is in its response's content alone.
- A subagent works in a thread and a rollout of its own, which fires `SubagentStop`, not `Stop`, so its model calls and tools are not recorded: its parent's trace holds the tool calls that started and waited on it. A multi-agent v2 subagent's activity (`SubAgentActivity`) is not read.
- A command still running as its turn closed completes later under that turn's id, and is not recorded.
- A `/review`'s turn, which Codex copies into the session without a close, is sent as cancelled once a later turn begins, where it holds a call.
- An ephemeral session has no rollout, and is not recorded.
- A turn closed after its `Stop`'s worker stopped waiting is sent at the next turn's end or the session's.
- Lines written for a turn after it was sent are not recorded.
- No image is sent, even with content on.
- Kept traces are capped at 200 a session, the oldest dropped. A session's state file is never removed.
