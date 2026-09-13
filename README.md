# AgentPack

**A cross-agent package manager for AI coding capabilities.**

[![CI](https://github.com/darkaimzzz/AgentPack/actions/workflows/ci.yml/badge.svg)](https://github.com/darkaimzzz/AgentPack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Install and manage MCP servers and marketplace plugins across Claude Code, Codex, and OpenCode from one desktop app. Scan a project, review the proposed changes, install, verify the servers actually start, control what each agent loads, and undo the run.

> We don't list tools — we install capability packs across your coding agents and prove they work.

## Why

The same capability needs different setup in every coding agent. Claude Code keeps MCP servers in `~/.claude.json` as JSON. Codex uses TOML tables in `~/.codex/config.toml`. OpenCode uses JSONC. Installing one MCP server across all three means reading three sets of docs, hand-editing three files, and having no way to tell whether any of it worked — or to undo it.

AgentPack collapses that into one flow:

```
DETECT agents + project stack
  → RECOMMEND from deterministic rules, with evidence
  → COMPILE one capability definition per agent format
  → INSTALL and write config surgically
  → VALIDATE by launching the server and reading tools/list
  → MANAGE what each session loads
  → ROLL BACK, ownership-aware
```

Adding a fourth agent is an adapter (~60 lines), not a rewrite.

## Status

Working and tested on **Windows x64**. macOS and Linux are not supported yet — see [#1 below](#roadmap). Release binaries are unsigned, so Windows SmartScreen will warn on first launch.

## Install

Requires **Node.js 22.17+** with npm on PATH. The packaged app bundles Electron, but MCP servers are launched with your installed Node runtime.

**Download** the portable executable from [Releases](https://github.com/darkaimzzz/AgentPack/releases), or build from source:

```powershell
git clone https://github.com/darkaimzzz/AgentPack.git
cd AgentPack
npm ci
npm run dist          # → release/AgentPack-<version>-win-x64.exe
```

### Try it without touching your real config

```powershell
npm run demo
```

`--demo` opens an isolated sandbox with three sample agent configs and a nested Next.js + Supabase project. Nothing outside the sandbox is read or written. Click **Scan demo project** → **Continue** → **Local Developer** → **Review plan** → **Install selected**; that pack needs no API keys.

**Without `--demo`, AgentPack reads and writes your real agent configuration.** `AGENTPACK_HOME` redirects both configs and state into an isolated directory if you want a softer sandbox.

Run `npm run prewarm` first on a slow connection — it downloads the MCP packages ahead of time so the first install isn't waiting on npm.

## What's included

- **Twelve MCP servers** — Playwright, Chrome DevTools, Filesystem, Git, Memory, Sequential Thinking, Context7, SQL Database (Postgres/MySQL/MariaDB/SQLite/SQL Server), MongoDB, Supabase, GitHub, Firecrawl. Every one was launched and made to answer `tools/list` before being added to the registry.
- **Eighteen marketplace plugins** — Superpowers, Claude Mem, Plannotator, Beads, Caveman, Karpathy Skills, Taste, plus GitHub, Vercel, Netlify, Sentry, Linear, Notion, Expo, Prisma, Redis, Semgrep and Figma from Anthropic's official marketplace. Plugins work in Claude Code and Codex; OpenCode uses a different plugin system.
- **Four packs** — Local Developer and Agent Craft (both credential-free), Full-Stack, and Data & Backend.
- Project detection with per-signal evidence: nested `package.json` files, Next.js configs, Supabase SSR dependencies and config folders, environment variable names.
- Target selection, credential entry, compatibility checks, progress logs, conflict reporting, rollback.
- Capability management: activate/deactivate, profiles, context cost estimates, file-pattern activation.
- Secret-free pack export/import via the CLI.

The registry is **curated and allow-listed**, not an open marketplace. Adding a capability is a pull request — see [CONTRIBUTING.md](CONTRIBUTING.md).

## How it works

| Agent | MCP configuration | Dormancy mechanism |
| --- | --- | --- |
| Claude Code | `~/.claude.json` (`mcpServers`) | No native flag — saves the full entry locally, then removes it from the live config |
| Codex | `~/.codex/config.toml` (`mcp_servers`) | Flips the native `enabled` flag |
| OpenCode | `~/.config/opencode/opencode.json` or `.jsonc` (`mcp`) | Flips the native `enabled` flag |

Config changes apply when the client reloads them or starts its next session.

### Capability Load Manager

Installed is not the same as loaded. Every active MCP server carries its full tool schemas — names, descriptions, JSON input schemas — into the agent's context at the start of every session, whether the task needs them or not. The **Manage** screen shows that cost and lets you turn a capability off without uninstalling it.

- **Measured, not guessed.** AgentPack launches each server, reads `tools/list`, and estimates from the serialized size. The Local Developer pack measures **39 tools · ~9,000 estimated tokens** (Playwright 24, Filesystem 14, Sequential Thinking 1).
- **Dormancy, per capability and per agent.** Where the format has a native `enabled` flag, nothing is removed. Where it doesn't (Claude Code), the complete entry — credentials included — is stashed locally and restored byte-for-byte on reactivation.
- **Profiles.** Frontend, Backend and Minimal are registry data, not code. Applying one computes a real diff against the live config and reports partial failure as partial. Membership is exhaustive: switching to Backend turns Playwright *off* as well as turning Supabase on.
- **File-pattern activation.** A declared glob — Playwright's `**/*.spec.ts`, say — reactivates a dormant capability when a matching file is touched. Activation only; a trigger never deactivates anything.

### Validation and recovery

"Healthy" means the server started, completed initialization, and returned a valid tool list. It does **not** prove account access or that every tool works. Plugin status reads **Configured**, never Verified, because a plugin loads inside the agent where AgentPack cannot observe it.

Before writing, AgentPack saves config snapshots and an install ledger under `~/.agentpack`. Rollback restores original bytes where it can, preserves unrelated later edits, and refuses to clobber a config that changed underneath it. Formats that carry comments (TOML, JSONC) take a surgical path so annotations added after install survive.

Context figures are tool-schema characters divided by four — an estimate of what an agent's *next* session will load, not billed tokens.

## CLI

```powershell
npm run cli -- scan C:\path\to\project
npm run cli -- install --pack local
npm run cli -- status
npm run cli -- rollback              # last run
npm run cli -- rollback --all
npm run cli -- export team-pack.json
npm run cli -- import team-pack.json
npm run cli -- clm
npm run cli -- clm measure --force
npm run cli -- clm use minimal
```

Exported manifests contain no secrets. Imports honour the manifest's targets and require its declared credential environment variables — inspect a manifest before importing one you didn't write.

## Security

AgentPack writes to files your coding agents execute from, and handles API credentials. Credentials are excluded from progress logs, the install ledger, exported manifests, and measurement metadata — but they are necessarily present in the agent configs, in config backups, and in the dormant entry store. Keep those files private.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

Adding a capability is a JSON file. Adding an agent is an adapter. Both are documented in **[CONTRIBUTING.md](CONTRIBUTING.md)**, along with the full check suite and what has to pass before a PR merges.

```powershell
npm run typecheck   # types
npm test            # deterministic fixture regressions
npm run check       # self-checks — launches real MCP packages
npm run e2e         # engine acceptance
npm run test:ui     # built Electron renderer, preload and IPC
npm run test:tools  # three real tool calls
npm run smoke       # fresh demo sandbox, app wiring
```

`npm run typecheck` and `npm test` are the two CI runs on every PR. The rest need network access and a desktop session, so they're local.

## Roadmap

1. **macOS and Linux support.** The engine is mostly portable; path resolution and packaging are not.
2. HTTP MCP servers — schema measurement is currently unavailable for them.
3. Signed release artifacts.
4. Verifying that a coding agent actually loaded a written config, rather than inferring it.

Issues and PRs welcome for any of these.

## Project layout

```
electron/core/agents      native config adapters (one per agent)
electron/core/detection   bounded project scan
electron/core/installer   process execution, validation, snapshots, ledger
electron/core/clm         capability states, profiles, measurement, triggers
electron/ipc              restricted desktop API surface
src                       React install wizard and management dashboard
registry                  curated capabilities, packs, profiles
scripts                   reproducible live acceptance tests
```

An external agent reviewed v1.6.0 with its own fault-injection fixtures and filed seven defects, three of them P1. All seven are fixed with regression tests; the review is published unedited in [docs/INDEPENDENT-REVIEW.md](docs/INDEPENDENT-REVIEW.md).

## Notes on the registry

The GitHub **MCP** entry is the archived `@modelcontextprotocol/server-github`, deprecated upstream and kept only because it is the one of the two that works in OpenCode. On Claude Code and Codex prefer the **GitHub plugin**, which is the maintained [official server](https://github.com/github/github-mcp-server) and authenticates inside the agent. The npm package published as `github-mcp-server` is unrelated to GitHub and is deliberately not used.

The app icon is drawn rather than designed: `build/icon.svg` for large sizes, `build/icon-small.svg` for 16 and 32px (the lamps and D-pad turn to mush below 48px). Rebuild `build/icon.ico` with `node scripts/make-icon.mjs`.

## License

[MIT](LICENSE)
