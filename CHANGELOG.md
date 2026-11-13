# Changelog

All notable changes to the `jubarteai` command line. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/); see [STABILITY.md](STABILITY.md) for what 1.x promises.

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
