# Codex Plugin — Agent Guidelines

The Codex plugin for Telmoni: a hook that records each turn of a person's Codex sessions as a run, metadata only unless content is on, through the platform's TypeScript SDK, bundled into `dist/worker.mjs`. The repository is the plugin and its own marketplace: Codex copies it and runs the hook from the copy, so every file here is published as written.

## Ground Rules
- **Metadata only, unless content is on.** The hook reads of a rollout its kinds, ids, times, counts and statuses: a turn's model and effort, each response's tokens, each tool call's kind, times and status, a command's exit code, an MCP tool's server and name, an error's kind, the session's provider and Codex's version; and of its payload, the session's `cwd` only to find `.telmoni-tags.json`, read for its tags alone. Never keep, log or send the working folder or a path as a field of its own; nor, with content off, a prompt, a reply, reasoning, the code the model ran, a command, a tool's input or output, a compaction's summary or an error's message. With content on, the conversation `ARCHITECTURE.md` names, with any path written in it, which the SDK sends only where the project's content mode is `on`; never the instructions Codex hands the model, nor its encrypted reasoning. A change that reads more of the rollout needs the owner's word, and a test that it is never sent (`assertMetadataOnly` in `tests/helpers.ts`).
- **Never read, print or copy a `.env`, Codex's credentials (`~/.codex/auth.json`), `~/.codex/telmoni.json` or a key.** A test, a fixture or a commit never holds a real key.
- **Ask first:** any dependency change (`package.json`, `package-lock.json`) and any external-state change (a listing in a directory, a call to a live Telmoni with a real key, a Codex session run against a real account).
- **Quality gate:** never weaken a test or leave the tree broken.
- **Build only what is asked:** the smallest change that does the task, in the files that already hold it. No feature, option, abstraction, layer, helper or file for a need that is not here yet, and no refactor beyond the task (a split, a rename, a rewrite for style): propose it with what it costs, and wait. A new repository, package, service or workflow is the owner's to make.
- **The hook never fails the session**: every fault is a log line and exit code 0, with nothing printed.

## Where Things Live
| Path | What |
|---|---|
| `.codex-plugin/plugin.json` | The manifest: name `telmoni-observability`, the version, the skills' folder and the page Codex shows (`interface`). No settings: Codex offers a plugin's hooks none. |
| `.agents/plugins/marketplace.json` | The marketplace, `telmoni-plugins`, naming this repository (`./`) as the plugin. |
| `hooks/hooks.json` | `Stop` and `SessionEnd`, each running `node "${PLUGIN_ROOT}/dist/hook.mjs" \|\| true`, and its `cmd` form on Windows. |
| `src/cli/hook.ts` | The command Codex runs, its payload on stdin: it starts the worker and returns, loading no SDK and printing nothing. |
| `src/cli/worker.ts` | The worker's entry point, its stop on stdin and the SDK in its bundle. |
| `src/*.ts` | `payload` (the hook's input), `paths` (Codex's folder, the key file, the plugin's data folder), `transcript` (the rollout's lines and what is read of them), `turns` (how turns are cut, and when they are complete), `record` (a turn as a run), `names` (what a record may call a model, a provider or a tool), `worker`. |
| `src/shared/` | Copies of the SDK's coding-agent module (`settings`, `log`, `state`, `send`, `tags`), the Antigravity plugin's too, changed from the SDK's only in their imports and Prettier's line width. |
| `dist/`, `tsup.config.ts` | The committed bundles, `hook.mjs` and `worker.mjs`: tsup builds them from `src/`, the SDK bundled into the worker, for Node 22 or later. Codex builds and installs nothing. |
| `skills/telmoni-observability/SKILL.md` | The skill: connecting the key, trusting the hooks, tags, the switches and the log. It runs nothing. |
| `assets/logo.png` | The logo the manifest names. |
| `tests/` | Vitest: `helpers.ts` writes rollouts as Codex writes them and stands in for Telmoni; `worker.test.ts` runs the worker end to end, the SDK included; `hook.test.ts` runs the built hook as Codex runs it; `install.test.ts` has a Codex install the plugin. |
| `package.json`, `package-lock.json`, `tsconfig.json`, `.prettierrc.json` | The npm commands and locked development dependencies, TypeScript's checks and Prettier's style; the SDK is bundled, with nothing to install at runtime. |
| `.github/workflows/` | `ci.yml`: the build and the suite on Node 22 and 26, Prettier and TypeScript checks, the rebuilt bundles checked against `dist/`, the plugin installed by a pinned Codex, and the workflows under actionlint. `release.yml`: on `main`, checks the versions agree and CI passed, tags a version bump once the owner approves the `release` environment, and cuts the release. |
| `ARCHITECTURE.md` | How Codex loads and runs it, what it reads, how turns are cut, what it sends, configuration, state and the log, delivery, testing, the release, decisions, known gaps. |
| [`telmoni/telmoni`](https://github.com/telmoni/telmoni) | Sibling repo, checked out as `../telmoni`: the SDK (`sdk/typescript`, `recordRun`, `src/coding-agent/`), and the book, whose `web/content/docs/api/coding-agents.mdx` is the coding agents' page. |

## Commands
- **After every change** (no permission needed; report failures verbatim): `npm run verify && npm run validate` — Prettier's check, tsc, the bundles rebuilt and the suite, then a Codex adding this repository as a marketplace and installing the plugin, in a Codex folder of its own.
- `npm run format` formats; `npm run format:check`, `npm run typecheck`, `npm run build`, `npm test` and `npm run validate` run Prettier's check, tsc, the bundles, the suite or the install check alone. The suite runs the SDK against a fake Telmoni and needs no network once `npm ci` has run; the install check needs `codex` on the `PATH`, or named in `CODEX_BIN`.
- **Until the SDK's next release**, the SDK is a development dependency on the core's checkout beside this one (`file:../telmoni/sdk/typescript`), built there first (`npm ci && npm run build` in `../telmoni/sdk/typescript`); CI checks out the core at `TELMONI_REF` in `ci.yml`, the commit whose SDK the committed `dist/` bundles, bumped with it.
- **Only when asked:** a run against a live Telmoni, a Codex session with the plugin's hooks trusted, a dependency upgrade with npm, a version bump.

## Code Rules
- Node 22 or later, as `package.json`'s `engines` sets; no runtime dependency but the SDK, bundled into the worker.
- A rollout line is read through `transcript.ts` alone; a new field read is named there, with its test.
- `src/shared/` changes only with the SDK's coding-agent module it copies.
- Comments are for a person reading the code, and short: they say *why*, never *what* — a doc comment in a line or two, an inline comment in one, a test's name saying what it proves. The reasoning behind a change (a race worked through, the designs turned down, its history) goes in `ARCHITECTURE.md` or the commit message, never above a function, and editing a comment means shortening its whole block.
- No AI signatures anywhere.

## Agent Hygiene
- **This repo only:** change nothing in another repository unless the user says so for this task; that binds subagents too. Reading is fine.
- Edit `AGENTS.md` only when the user asks outright; otherwise propose a diff.
- No scripted bulk edits. One-off scripts and logs go in `/tmp/telmoni/`. A fixture is synthetic, written as Codex writes a rollout (`tests/helpers.ts`), never a recorded session.

## Git Rules
- Commit only when asked: never `git add` or `git commit` unprompted.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`) of 1–5 lines and the sign-off: a subject, then optionally a blank line and up to 3 lines on *why*. No file lists, test output, AI signatures or `Co-authored-by` trailers.
- Every commit is signed off by the developer it is made for, certifying the [Developer Certificate of Origin](https://developercertificate.org/): `git commit -s` adds `Signed-off-by: Name <email>` from git's `user.name` and `user.email`, which name a person, never an agent. A merge commit too: a branch is merged in a clone, `git merge --no-ff --signoff`, and pushed, never from GitHub's merge button, whose commit carries none.
- A release is the version bumped in `.codex-plugin/plugin.json` and `package.json` in one commit on `main`, made when the owner says, which CI tags and releases on the owner's approval; never a tag by hand.
- No branches, worktrees, pushes or pull requests.

## Definition of Done
- [ ] `npm run verify && npm run validate` pass, or the failure is reported verbatim.
- [ ] Nothing of a session reaches an export, the state, the log, a test fixture or a commit, but the conversation an export and the state carry where content is on.
- [ ] `ARCHITECTURE.md` and the README say what changed; the book's `web/content/docs/api/coding-agents.mdx` (`../telmoni`) is fixed or named.
- [ ] Nothing that needs asking happened unasked.
