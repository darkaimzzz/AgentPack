# AgentPack

**A cross-agent package manager for AI coding capabilities.**

Configure MCP servers and marketplace plugins across Claude Code, Codex, and OpenCode from one desktop app. Scan a project, review the proposed changes, install, check server health, manage what each agent loads, and undo the run.

Built for HackBattle — IEEE Computer Society, VIT Vellore.

## The problem

The same capability needs different setup in every coding agent. Claude Code keeps MCP servers in `~/.claude.json` as JSON, Codex uses TOML tables in `~/.codex/config.toml`, OpenCode uses JSONC. Installing one MCP server across all three means reading three sets of docs, editing three files by hand, and having no way to tell whether any of it actually works — or to undo it.

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

Adding a fourth agent is an adapter, not a rewrite.

## Run the demo

Requires Windows x64 and Node.js **22.17 or newer** with npm on PATH. Internet access is needed for the first MCP package download. The desktop executable bundles Electron, but MCP servers still use the installed Node runtime.

```powershell
npm ci
npm run prewarm
npm run demo
```

`npm run demo` opens a fresh sandbox containing three sample agent configs and a nested Next.js + Supabase project. Click **Scan demo project**, **Continue**, choose **Local Developer**, then **Review plan** and **Install selected**. This pack needs no API keys.

The portable build is `release/AgentPack-1.1.0-win-x64.exe`:

```powershell
.\release\AgentPack-1.1.0-win-x64.exe --demo
```

Without `--demo`, AgentPack reads your real agent configuration. Use `npm run dev` for development or `npm start` after building.

For the presentation itself — preparation, a five-minute script with exact clicks, judge questions and a failure playbook — see **[the demo workflow](docs/DEMO.md)**. The scored engineering assessment and known gaps are in **[READINESS.md](docs/READINESS.md)**.

## What is included

- Six MCP servers: Playwright, Filesystem, Sequential Thinking, Context7, GitHub, Supabase.
- Four marketplace plugins: Superpowers, Claude Mem, Plannotator, Beads. Plugins are supported in Claude Code and Codex; OpenCode uses a different plugin system.
- Two packs: Local Developer and Full-Stack.
- Nested project detection with evidence for each signal, including Next.js configs, Supabase SSR dependencies, Supabase config folders, and environment variable names.
- Target selection, credential entry, compatibility checks, progress logs, conflict reporting, and rollback.
- Capability management: activate/deactivate, profiles, schema cost estimates, and file-pattern activation.
- Secret-free pack export/import through the CLI.

| Agent | MCP configuration | Dormancy |
| --- | --- | --- |
| Claude Code | `~/.claude.json` (`mcpServers`) | Saves the full native entry locally, then removes it from the live config |
| Codex | `~/.codex/config.toml` (`mcp_servers`) | Changes the native `enabled` flag |
| OpenCode | `~/.config/opencode/opencode.json` or `.jsonc` (`mcp`) | Changes the native `enabled` flag |

Agent config changes apply when the client reloads them or starts its next session. The demo sandbox exercises real config translation and real MCP servers; it does not launch three coding-agent sessions.

## Capability Load Manager

Installed is not the same as loaded. Every active MCP server carries its full tool schemas — names, descriptions and JSON input schemas — into the agent's context at the start of every session, whether the task needs them or not. The **Manage** screen shows that cost and lets you turn it off without uninstalling anything.

- **Measured cost, not a guess.** AgentPack launches each server, reads the `tools/list` response and estimates from its serialized size. The Local Developer pack measures **39 tools · ~9,000 estimated tokens** (Playwright 24, Filesystem 14, Sequential Thinking 1).
- **Dormancy, per capability and per agent.** Codex and OpenCode have a native `enabled` flag. Claude Code has none, so the complete entry — credentials included — is saved to a local store and removed from the live config, then restored byte-for-byte on reactivation.
- **Profiles.** Frontend, Backend and Minimal are registry data. Applying one computes a real diff against the live config and reports partial failure as partial.
- **File-pattern activation.** A declared glob, such as Playwright's `**/*.spec.ts`, reactivates a dormant capability when a matching file appears.

Changes are written to the live agent configuration and backed up first. They take effect in the agent's **next** session: Claude Code reads MCP configuration at session start and exposes no hot-reload. Estimates are tool-schema characters divided by four, not billed tokens.

## Validation and recovery

MCP health means the server started, completed initialization, and returned a valid tool list. It does **not** prove account access or every tool operation. Plugin status is **Configured**, since AgentPack does not verify that a client has downloaded or loaded the plugin.

Before writing, AgentPack saves config snapshots and an install ledger under `~/.agentpack`. Rollback restores original bytes when possible, preserves unrelated later edits, and refuses conflicting edits to an owned capability. If a config changes during installation, subsequent writes to that file stop. Reactivate a natively disabled capability before undoing its original installation if rollback reports a conflict.

Credentials are excluded from progress logs, the install ledger, exported manifests, and measurement metadata. They are still present in the agent configs, config backups, and Claude's dormant credential store. Keep those files private. `AGENTPACK_HOME` redirects both configs and state into an isolated directory.

Context estimates use serialized tool-schema characters divided by four, once per installed capability. They are not billed tokens or a promise about what a particular agent loads. HTTP MCP schema measurement is currently unavailable.

## CLI

```powershell
npm run cli -- scan C:\path\to\project
npm run cli -- install --pack local
npm run cli -- status
npm run cli -- rollback
npm run cli -- rollback --all
npm run cli -- export team-pack.json
npm run cli -- import team-pack.json
npm run cli -- clm
npm run cli -- clm measure --force
npm run cli -- clm use minimal
```

Imports honor the manifest's targets and require its declared credential environment variables. Inspect the manifest before importing it. The GitHub entry uses the pinned legacy stdio server; migration to the [maintained GitHub MCP server](https://github.com/github/github-mcp-server) is a release follow-up. Use the Local Developer pack for a demo that does not depend on external account access.

## Checks and packaging

```powershell
npm run typecheck
npm test
npm run check
npm run e2e
npm run test:ui
npm run test:tools
npm run smoke
npm run dist
```

`npm test` runs focused fixture regressions. `check` and `e2e` also start real MCP packages; `test:ui` drives the built Electron renderer, preload and IPC; `test:tools` executes three real tool calls. These checks use synthetic configs. UI evidence is saved under ignored `.qa/`. `smoke` opens a fresh demo sandbox and checks application wiring.

`dist` creates a Windows portable executable. The current artifact is unsigned. Runtime dependency audit: `npm audit --omit=dev`.

## Code layout

- `electron/core/agents`: native config adapters
- `electron/core/detection`: bounded project scan
- `electron/core/installer`: process execution, validation, snapshots and ledger
- `electron/core/clm`: capability states, profiles, measurements and triggers
- `electron/ipc` and `electron/preload.ts`: restricted desktop API
- `src`: React install wizard and management dashboard
- `registry`: curated capabilities, packs and profiles
- `scripts`: reproducible live acceptance tests
