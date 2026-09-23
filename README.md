# AgentPack

[![CI](https://github.com/darkaimzzz/AgentPack/actions/workflows/ci.yml/badge.svg)](https://github.com/darkaimzzz/AgentPack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A desktop app that installs and manages MCP servers and marketplace plugins across Claude Code, Codex, and OpenCode.

Each agent stores MCP configuration in a different place and format: `~/.claude.json` as JSON, `~/.codex/config.toml` as TOML, `~/.config/opencode/opencode.json` as JSONC. AgentPack writes one capability into all three, launches each server to confirm it actually responds, and can undo the whole run.

## Requirements

- **Windows x64.** macOS and Linux are not supported yet.
- **Node.js 22.17 or newer**, with npm on PATH. The app bundles Electron, but MCP servers are launched with your installed Node.
- Internet access on first install, to download MCP packages.

## Installation

Download the portable `.exe` from [Releases](https://github.com/darkaimzzz/AgentPack/releases) and run it. No installer, no admin rights.

Releases are unsigned, so Windows SmartScreen will warn on first launch: *More info* → *Run anyway*. Each release publishes a SHA-256 you can check:

```powershell
Get-FileHash .\AgentPack-2.1.0-win-x64.exe -Algorithm SHA256
```

### From source

```powershell
git clone https://github.com/darkaimzzz/AgentPack.git
cd AgentPack
npm ci
npm run dist     # → release/AgentPack-<version>-win-x64.exe
```

Or run it directly: `npm run build && npm start`.

## Usage

Launch the app. It detects which agents are installed, then:

1. **Scan** a project folder. It reports what it found and the file that proves it.
2. **Review** the recommendations, pick capabilities and which agents to install them into.
3. **Install.** Credentials are requested only where a capability declares them.
4. **Verify.** Each MCP server is launched and asked for its tool list.
5. **Manage** what each agent loads, or **roll back** the run.

Config changes take effect when the agent next starts a session. Claude Code reads MCP configuration at startup and has no hot-reload.

> **AgentPack writes to your real agent configuration.** Every write is backed up first and is reversible from the app, but it is editing live files. Pass `--demo` to work in a throwaway sandbox instead, or set `AGENTPACK_HOME` to redirect both configs and state somewhere isolated.

### Command line

```powershell
npm run cli -- scan C:\path\to\project
npm run cli -- install --pack local
npm run cli -- status
npm run cli -- rollback            # last run; --all for everything
npm run cli -- export team.json    # no secrets are written
npm run cli -- import team.json
npm run cli -- clm                 # what each agent currently loads
npm run cli -- clm use minimal
npm run cli -- prewarm             # download MCP packages ahead of time
```

### Environment variables

| Variable | Effect |
| --- | --- |
| `AGENTPACK_HOME` | Redirect agent configs and app state to an isolated directory |
| `AGENTPACK_REGISTRY` | Load capability definitions from elsewhere |
| `AGENTPACK_NO_BOOT=1` | Skip the startup animation (`AGENTPACK_BOOT=1` forces it on) |

## What's included

**Twelve MCP servers**: Playwright, Chrome DevTools, Filesystem, Git, Memory, Sequential Thinking, Context7, SQL Database (Postgres/MySQL/MariaDB/SQLite/SQL Server), MongoDB, Supabase, GitHub, Firecrawl.

**Eighteen marketplace plugins**: Superpowers, Claude Mem, Plannotator, Beads, Caveman, Karpathy Skills, Taste, plus GitHub, Vercel, Netlify, Sentry, Linear, Notion, Expo, Prisma, Redis, Semgrep and Figma from Anthropic's official marketplace. Plugins work in Claude Code and Codex; OpenCode uses a different plugin system.

**Four packs**: Local Developer and Agent Craft (neither needs API keys), Full-Stack, Data & Backend.

The registry is curated and allow-listed, not an open marketplace. Every entry names a publisher, pins an exact version, and was launched and observed answering `tools/list` before being added. Adding one is a pull request.

## Managing what gets loaded

Installed is not the same as loaded. Every active MCP server pushes its full tool schemas into the agent's context at the start of every session, whether the task needs them or not. The **Manage** screen measures that and lets you switch a capability off without uninstalling it.

Where the config format has a native `enabled` flag (Codex, OpenCode), nothing is removed. Claude Code has no such flag, so the entry, credentials included, is stored locally and restored byte-for-byte when you switch it back on.

Profiles (Frontend, Backend, Minimal) are registry data. Applying one diffs against the live config; membership is exhaustive, so switching to Backend turns Playwright off as well as turning Supabase on. A capability can also declare file globs that reactivate it, Playwright's `**/*.spec.ts`, for instance.

## Limitations

- Windows only.
- Release artifacts are unsigned.
- A healthy server means it started and returned a valid tool list. It does **not** prove your credentials are valid or correctly scoped.
- Plugin status reads *Configured*, never *Verified*: a plugin loads inside the agent, where AgentPack cannot observe it.
- Context figures are estimates: tool-schema characters ÷ 4, not billed tokens.
- HTTP MCP servers cannot be measured yet.
- AgentPack cannot confirm that an agent actually loaded a config it wrote.

Backups and an install ledger are kept under `~/.agentpack`. Rollback restores original bytes where it can, preserves unrelated later edits, and refuses rather than guessing if a file changed underneath it.

## Development

```powershell
npm run dev         # Electron + Vite, hot reload
npm run typecheck
npm test            # deterministic regressions
```

Those last two run in CI on every pull request. Fuller checks need network access or a desktop session: `npm run check`, `npm run e2e`, `npm run test:ui`, `npm run test:tools`, `npm run smoke`.

```
electron/core/agents      config adapters, one per agent
electron/core/detection   project scan
electron/core/installer   process execution, health probes, backups, ledger
electron/core/clm         capability state, profiles, measurement, triggers
electron/ipc              privileged operations behind restricted IPC
src                       React renderer
registry                  capabilities, packs and profiles as JSON
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to add a capability or an agent. An external review of v1.6.0 and the seven defects it found are in [docs/INDEPENDENT-REVIEW.md](docs/INDEPENDENT-REVIEW.md).

## Security

AgentPack writes files your coding agents execute from, and handles API credentials. See [SECURITY.md](SECURITY.md) for the threat model, where credentials actually live, and how to report a vulnerability.

## License

[MIT](LICENSE)
