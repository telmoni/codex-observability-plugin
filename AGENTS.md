# Telmoni for Codex — Agent Guidelines

The Codex plugin for Telmoni ([`telmoni/codex-observability-plugin`](https://github.com/telmoni/codex-observability-plugin)): a hook that records each turn of a person's Codex sessions as a run, metadata only, through the TypeScript SDK of the platform ([`telmoni/telmoni`](https://github.com/telmoni/telmoni), `sdk/typescript`). It reaches a person's machine as the npm package `@telmoni/codex-observability-plugin` alone, which this repository's marketplace, `telmoni-plugins`, names. The repository is public, and every file in it is published as written.

## Ground Rules
- **Pre-launch:** nothing has shipped. Change the record, the state and the manifests to their ideal state; no migration paths.
- **Quality gate:** never weaken a test or leave the tree broken.
- **Ask first:** any dependency change (an edit to `package.json` or `package-lock.json`, lockfile-only refreshes included) and any external-state change (publishing to npm, a listing in a vendor's directory, a call to a live Telmoni with a real key).
- **Metadata only, by construction:** a record holds a model, token counts, tool names, times and outcomes. Never a prompt, a reply, a thought or its summary, a tool's arguments or output, a command, a file's path, the working folder or an email — the hook picks what it keeps out of each line by field name, and keeps nothing else.
- **The session never waits:** the hook hands its work to a detached copy of itself and exits at once, printing nothing, since Codex reads a `Stop` hook's output as its decision; a failure is a line in `hook.log` naming its kind, never anything from the session, and the hook exits 0 whatever happened.

## Where Things Live
| Path | What |
|---|---|
| `src/hook.ts` | The entry Codex runs: reads its input, starts the detached copy, exits. |
| `src/session.ts` | One hook's work on one session: a thread's turns ended since the last hook, each sent and its place saved; at the session's end, its subagents' threads too. |
| `src/rollout.ts` | The rollout read forward from an offset, each line kept as far as the metadata goes: the one place a line is parsed. |
| `src/turns.ts` | The lines cut into turns, the thread's own told from those it copied from another, each gathered into responses and tool calls. |
| `src/record.ts` | A turn as the SDK's `RunRecord`; the run id derived from the session and the turn. |
| `src/send.ts`, `src/state.ts`, `src/settings.ts`, `src/input.ts`, `src/log.ts` | Sending through the SDK; each thread's state and lock; the key, endpoint and folder; the hook's input; `hook.log`. |
| `tests/` | The suites; `tests/fixtures/` holds synthetic rollouts, every text in them fake, its `README.md` saying how they were made. |
| `.codex-plugin/plugin.json`, `hooks/hooks.json` | The plugin, shipped in the package: its manifest and its four hooks. |
| `.agents/plugins/marketplace.json` | The marketplace, `telmoni-plugins`, naming the npm package; added sparse, so an install never fetches `src/` or `tests/`. |
| `ARCHITECTURE.md` | How the plugin works, and why. |
| [`telmoni/telmoni`](https://github.com/telmoni/telmoni) | Sibling repo, checked out as `../telmoni`: the SDK this plugin is built on (`sdk/typescript`, `recordRun`), which it takes from npm as `telmoni`. |
| [`telmoni/docs`](https://github.com/telmoni/docs) | Sibling repo, checked out as `../docs`: the book, whose `api/coding-agents.mdx` documents this plugin. |

## Commands
- **After every change** (no permission needed; report failures verbatim): `make check` — the types, the bundle and the suites (`npm run verify`), the manifests and the package among them, since Codex ships no validator for either.
- **Locally:** `node dist/hook.mjs`, a hook's input on its stdin, runs the hook as Codex does. To run it inside Codex before the package is published, build, copy what the package holds (`.codex-plugin/`, `hooks/`, `dist/`, `package.json`) into a folder inside a marketplace of your own, name it there as a local source (`{"source": "local", "path": "./…"}` — Codex takes only a `./` path inside the marketplace's folder), and add the plugin from there. Codex copies a local plugin whole into its cache as it is added, so add it again after each build; its hooks want trusting in `/hooks`, as any do.

## Code Rules
- TypeScript on Node 22, bundled by tsup into the one file `dist/hook.mjs` with the SDK inside it: Codex installs the package with no install scripts and no dependencies. Nothing built is committed.
- Everything that leaves goes through the SDK's `recordRun`, never a request of the plugin's own: the contract, the content rules and the retries are the SDK's.
- A rollout's fields are read in `src/rollout.ts` alone, each by name, and only where it is metadata: nothing reads a line's text, arguments or output, not even for an exit code.
- Comments are for a person reading the code, and short: they say *why*, never *what* — a doc comment in a line or two, an inline comment in one, a test's doc in one line on what it proves. The reasoning behind a change (a race worked through, the designs turned down, its history) goes in `ARCHITECTURE.md` or the commit message, never above a function, and editing a comment means shortening its whole block. No AI signatures anywhere.
- Never log a key, a token or anything read from a session; log kinds.

## Agent Hygiene
- **This repo only:** change nothing in another repository unless the user says so for this task; that binds subagents too. Reading is fine.
- Edit `AGENTS.md` only when the user asks outright; otherwise propose a diff.
- No scripted bulk edits. One-off scripts and logs go in `/tmp/telmoni/`. A fixture is synthetic, or scrubbed before it is written here: kept fields allowlisted, every text replaced, every id renamed, every time shifted.
- Never read, print or copy a `.env` file or Codex's `auth.json`, and never put a real key in a test, a fixture or a commit.

## Git Rules
- Commit only when asked: never `git add` or `git commit` unprompted.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`) of 1–5 lines and the sign-off: a subject, then optionally a blank line and up to 3 lines on *why*. No file lists, test output, AI signatures or `Co-authored-by` trailers.
- Every commit is signed off by the developer it is made for, certifying the [Developer Certificate of Origin](https://developercertificate.org/): `git commit -s` adds `Signed-off-by: Name <email>` from git's `user.name` and `user.email`, which name a person, never an agent.
- No branches, worktrees, pushes or pull requests.

## Definition of Done
- [ ] `make check` passes, or the failure is reported verbatim.
- [ ] No key, no text from a session and no path reaches a log, a record, a fixture or a commit.
- [ ] `ARCHITECTURE.md` and `README.md` say what changed, and the book's `api/coding-agents.mdx` (`../docs`) is fixed or named.
- [ ] Nothing that needs asking happened unasked (dependencies, publishing, live calls, other repos, commits).
