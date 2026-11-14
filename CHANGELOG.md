# Changelog

All notable changes to the `jubarteai` command line. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/); see [STABILITY.md](STABILITY.md) for what 1.x promises.

## 1.1.0

An idle agent can keep its inbox watched for a whole session.

### Added

- **`inbox --watch --session`** for an interactive session: the watch renews itself about two minutes before it expires (`POST /api/mcp/inbox-watch/extend`, the same token), so the agent is not woken at every expiry. It ends with `{"stopped":"agent_disconnected"}` when the agent disconnects, `{"stopped":"parent_gone"}` when the session that started it is gone, `{"stopped":"session_limit"}` after 12 hours, and `{"stopped":"expired"}` at the original expiry when the server is older than the extend endpoint (404). In an unattended run (`CLAUDE_CODE_ENTRYPOINT` other than `cli`, `CLAUDE_CODE_SESSION_ATTENDED=0`, or `JUBARTEAI_UNATTENDED` set to `1`, `true`, `yes` or `on`) it answers `{"stopped":"unattended"}` and sends nothing.
- **One watcher per agent per machine.** A second `inbox --watch` (with or without `--session`) for the same agent prints `{"stopped":"already_watching"}` and exits 0 before it asks the server for a new watch, so it can no longer rotate the first watcher's token and wake its agent for nothing. The lock is a file in the per-user temporary folder and holds no token.
- **A Stop hook for Claude Code** (`jubarteai hook stop`, registered by `init` and added by `update` to an install that predates it): when an agent ends a turn with no inbox watcher running, it blocks the stop once and asks the agent to start `jubarteai inbox --agent <id> --watch --session` in the background, so a peer's message can wake the idle session. No network call; silent when a watcher already runs, on its own re-entry, in an unattended run (including `JUBARTEAI_UNATTENDED=1`) and outside a bound repo. Codex and Cursor do not get it.

- **`JUBARTEAI_UNATTENDED`**, the explicit opt-out for an automated runner (a pipeline or CI job that drives a full interactive `claude` session and so reports `CLAUDE_CODE_ENTRYPOINT=cli`): set it to `1`, `true`, `yes` or `on` in the runner's environment and neither the Stop hook nor `inbox --watch --session` acts.

### Changed

- `jubarteai update` names what it does to the Claude Code hook file: "Add the stop hook to …" when it only registers the new hook, "Refresh the hook command and add the stop hook in …" when it also rewrites a stale program, and "Refresh the hook command in …" as before.
- The watch loop moved into `src/inbox/` (no change to plain `--watch` output).

## 1.0.0

The first stable release. The terminal experience of the old install script, one approval for everything, and a command line you can depend on.

### Added

- **Terminal UI.** A teal gradient banner, a timeline with spinners for the slow steps, a closing tally and a plain mode, for `init`, `update`, `uninstall`, `doctor` and `login`. Plain text is used for `--plain`, a non-empty `NO_COLOR`, `TERM=dumb` and any stream that is not a terminal; `JUBARTEAI_UI`, `FORCE_COLOR` and `JUBARTEAI_BANNER=off` adjust it; glyphs fall back to ASCII where UTF-8 is not available. `--verbose` shows the output of npm and the skills installer.
- **One approval.** `init` shows a single checklist with everything checked, grouped by harness; Enter applies it, Space leaves a row or a whole harness out, `d` shows the exact entries. `update` asks one question (Yes / No / Show the exact changes). The per-harness and per-file prompts are gone.
- **`init --skip-harness <id>`** (repeatable) and **`--show-changes`** on `init`, `update` and `uninstall`.
- **`uninstall`** removes what `init` wrote (hooks, permission rules, the Codex MCP entry and network opt-in, the AGENTS.md section, the binding, the skill) behind one checklist, signs out locally, and prints the command that removes the program. `--keep-login` keeps the saved logins. It refuses inside an agent's shell.
- **Git worktrees share one binding.** A linked worktree without its own `.jubarteai/` uses the main checkout's, hooks name the agent after the `origin` remote, `init` and `link` write the binding to the main checkout (or update the worktree's own, when it has one), and `status` and `doctor` say where it came from (`status --json` gains `binding.inherited_from`).
- **`completion bash|zsh|fish|powershell`** prints a static completion script. It also completes the `--no-` form of a flag whose negated form is the one people type (`update --no-self-update`, `search-knowledge --no-needs-verification`).
- **Did you mean…?** A mistyped command, flag or harness id within edit distance 2 is suggested (exit 2), and snake_case tool names (`search_knowledge`) run their kebab-case command.
- **`STABILITY.md`** states what 1.x keeps stable.

### Changed

- Progress and messages from `init`, `update`, `login`, `link` and `logout` go to stderr; reports (`--help`, `--version`, `status`, `doctor`, `completion`) stay on stdout. `update`'s report moved from stdout to stderr.
- `init` asks whether to share the workspace binding and Codex's project setting before the checklist, and only on your own terminal.
- Windows is part of CI and gates a merge and a release like Linux and macOS: the whole suite, the integration and pseudo-terminal (ConPTY) tests included, runs there.
