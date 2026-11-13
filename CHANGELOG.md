# Changelog

All notable changes to the `jubarteai` command line. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/); see [STABILITY.md](STABILITY.md) for what 1.x promises.

## 1.1.0

Company skills: the skills your workspace's owners and admins approve are synced into each repository, so every connected agent uses them like local skills.

### Added

- **`jubarteai skills sync | status | clean`.** `sync` writes the workspace's enabled skills into the repo's skill folders (`.claude/skills` and `.agents/skills`, plus any other harness folder `init` set up, such as `.windsurf/skills`), removes the ones no longer enabled, and keeps them out of `git status` with a managed block in `.git/info/exclude`. Each folder carries an ownership marker; a folder without one is never touched and is reported as a clash. `status` is offline. `clean` removes only what the CLI synced.
- **Automatic sync from the hooks.** `connect` and `check_inbox` now return a `skills_revision`; when it differs from what the repo last synced, the session-start and prompt hooks start a detached background sync (never waiting for it) and, once, tell the agent what changed. After a failure, a new sync waits 10 minutes.
- **Two tools: `list-skills` and `get-skill`** (`list_skills`, `get_skill`), also usable without the CLI sync. `get-skill --manifest` returns each file's path, size, sha256, executable bit and a short-lived download URL.
- **`uninstall`** asks whether to remove the company skills it synced into the repo (default No; `--yes` removes them; without a terminal they are kept and `jubarteai skills clean` is named).

### Notes

- Files are downloaded from signed storage URLs with no credentials and no redirects, and each file's size and sha256 are checked before anything is written. Folders are staged and swapped in, so an interrupted sync leaves the old or the new folder, never half of one.
- A skills folder that is a symlink (a shared `.claude/skills`, say) is never written through. `skills status` lists it under `skipped_targets`, and a foreground `skills sync` prints a line saying so (and carries `skipped_targets` in its result), so the skip is never silent.
- An older server without company skills is treated as having none. Nothing changes for workspaces on a plan without them.

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
