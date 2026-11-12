# Stability

From 1.0.0 the `jubarteai` command line follows semantic versioning. This page says what is covered by that promise, so a script, a harness hook or a CI job written against 1.x keeps working across every 1.x release.

## What stays stable in 1.x

- **Command names**, and the snake_case aliases of the tool commands (`search_knowledge` runs `search-knowledge`). A command is never renamed or removed in a minor or patch release; a replacement gets a new name and the old one stays as an alias.
- **Flags and their types** on every command, and the global flags `--workspace`, `--agent`, `--pretty`, `--yes`, `--plain`, `--verbose`, `--help`, `--version`. A flag is never removed or given a different meaning; a new flag is optional.
- **Exit codes** `0` to `5`: `0` success, `1` the server returned an `error` (or `doctor` found a failure, or `update` hit a failed step), `2` usage error (or `update --check` found something to change), `3` authentication, `4` network or server error, `5` not signed in.
- **The tool-command envelope** on stdout: one line of JSON, `{"messages":[…],"result":…}` or `{"messages":[…],"error":"…"}`, `messages` first; and, for transport failures, `{"messages":[],"error":"…","code":"…"}`.
- **The hook command line** harnesses run: `jubarteai hook <session-start|user-prompt-submit|session-end> --harness <id>`, its JSON on stdin and its silence outside a bound repo.
- **File formats marked `version: 1`**: the repo binding (`.jubarteai/config.json`, `config.local.json`), the saved logins (`credentials.json`) and the session cache. A change to them is additive, or a new `version` that 1.x still reads.
- **Environment variables**: `JUBARTEAI_TOKEN`, `JUBARTEAI_URL`, `JUBARTEAI_UI` (`plain` or `rich`), `JUBARTEAI_BANNER` (`off`), `NO_COLOR` and `FORCE_COLOR` as documented in the README.
- **`status --json` and `doctor --json`**: fields are only added, never removed or retyped.
- **Node support**: a Node version is dropped only in a major release, except that the floor moves up to the patched release of a supported line when that line publishes a security fix (the README names the floor).

## What is not covered

- **Human text**: banners, headings, progress lines, colours, glyphs, the wording of messages and of `--help`, the order of lines in `status` and `doctor` text. Parse `--json`, the envelope or the exit code, not these.
- **Which output stream carries a progress message**, except that reports (`--help`, `--version`, `status`, `doctor`, `completion`) go to stdout and tool-command JSON goes to stdout.
- **Which files `init` writes for a harness** when the harness changes its own configuration format; `init` follows the vendor's documentation, and `update` refreshes what it wrote.
- **The set of detected harnesses**: support for a new harness is added in a minor release.
- Internal modules. The package exposes a command line, not a library.

## Deprecation

A deprecated flag or command keeps working for the rest of the major version and prints a one-line notice on stderr. It is removed only in the next major release, which `CHANGELOG.md` announces.
