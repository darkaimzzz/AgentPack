# CLAUDE.md

Guidance for AI agents working in this repository. Human contributors want
[CONTRIBUTING.md](CONTRIBUTING.md), which this file deliberately does not duplicate.

## What this is

AgentPack is a cross-agent package manager for MCP servers and marketplace plugins.
It detects installed coding agents and the project stack, recommends capabilities
deterministically, compiles one capability definition into each agent's native config
format, installs, validates by actually launching the server, manages what each agent
loads, and rolls back.

The differentiating system is the pipeline, not the catalog:

```
DETECT → RECOMMEND → COMPILE → INSTALL → WRITE CONFIG → VALIDATE → ROLL BACK
```

## The invariant that governs everything

**Never claim what has not been observed.**

- Health is `verified` (server started and answered `tools/list`), `configured`
  (written correctly, unobservable from here), or `failed`. Plugins are never
  `verified`, they load inside the agent.
- Context figures are *estimated* (schema characters ÷ 4), never "tokens".
- Rollback refuses and explains rather than guessing when it cannot prove what this
  run wrote. See `installer/backup.ts`.
- `validate()` on an adapter must not swallow parse errors. The readers deliberately
  do, which is why a separate non-swallowing method exists, without it "no entries"
  and "unreadable file" are indistinguishable.

If a change would make the UI, a log line, or a return value assert more than the code
actually established, that is a defect regardless of how much nicer it reads.

## Architecture

```
electron/main.ts           window, boot guards, smoke hook
electron/preload.ts        the only renderer↔main bridge
electron/ipc/handlers.ts   every privileged operation, sender-verified
electron/core/
  agents/                  one adapter per agent + shared adapter.ts contract
  capabilities/registry.ts loads registry/ from disk; never hard-coded
  detection/project.ts     bounded scan, evidence per signal
  recommendations/rules.ts deterministic rules, no model in the path
  installer/               run, health (JSON-RPC probe), backup, install, ledger
  clm/                     state, dormant store, profiles, triggers, cost
  files.ts                 atomicWrite, use it for every config write
src/                       React renderer. No shell, no fs, IPC only.
registry/                  capabilities, packs, profiles as JSON data
```

**The renderer never executes shell commands or touches the filesystem.** Everything
privileged lives in main behind an explicit IPC channel. `registerHandlers` verifies
`event.sender` and `event.senderFrame` against the owning window's main frame; route
new operations through its `handle()` wrapper so they inherit that check.

### Config writing

Three rules, all of them learned from a bug:

1. **Atomic**, `atomicWrite` (temp + rename, mode 0600). An agent may be reading.
2. **Surgical**, never re-serialize a whole document. TOML and JSONC carry user
   comments; a parser round-trip deletes them. Splice the table or key. `codex.ts`
   has `removeTomlTable` for this; do not hand-roll a second copy of it.
3. **Refuse rather than guess**, if the document is shaped in a way the adapter
   cannot edit safely, throw with a message the user can act on.

### Credentials

Excluded from: progress events, install ledger, exported manifests, measurement
metadata, MCP protocol errors, stderr tails. Present in: agent configs, config
backups, and `clm/dormant.ts`, which is loudly commented and must stay that way.

A parse error must never quote the offending source line: those lines can hold
credentials from entries AgentPack never wrote and therefore cannot redact. Keep the
diagnostic, drop the excerpt.

### CLM (Capability Load Manager)

Dormancy has two mechanisms. Where the format has a native `enabled` flag, the adapter
implements `setEnabled` and nothing is ever removed. Where it does not (Claude Code),
the entry is stashed *before* removal and dropped only once it is demonstrably back in
the live config, the stash is the sole surviving copy of those credentials.

**The live config is always the source of truth.** `reconcile()` drops a stale stash
when the config disagrees; it never rewrites config to match stored state.

## Working here

- **Reproduce before fixing.** Every regression test in this repo reproduces the
  original failure rather than asserting the fix. Follow that pattern.
- **Read output, don't assert it.** If you claim a check passed, paste what it printed.
- **Fix at the shared function**, not per caller. `removeTomlTable` exists because two
  copies of the same scan drifted and only one got the trailing-comment fix.
- Comments explain *why*. Many record a specific bug that was hit, do not delete them
  during cleanup.
- `node:test` + `node:assert/strict`, temp `AGENTPACK_HOME` per case, no framework.
  New test files go in `package.json`'s `test` script.

### Checks

```powershell
npm run typecheck   # + npm test, the two that run in CI
npm test
npm run check       # engine self-checks, launches real MCP packages
npm run e2e         # acceptance, byte-identical rollback
npm run test:ui     # built renderer + preload + IPC
npm run test:tools  # real tools/call round trips
npm run smoke       # fresh sandbox, app wiring
```

Never run a check that writes config without `--demo` or `AGENTPACK_HOME` set.

If MCP probes are inexplicably slow, check `npm ping` before blaming the code, a
failing registry certificate makes npm retry for ~70s before falling back to a cache
it already has. Health checks set `npm_config_prefer_offline` for exactly this reason.

## Deliberate non-goals

Do not, without an issue discussing it first:

- Turn the registry into an open marketplace, or fetch capability definitions at
  runtime. It is curated and allow-listed; that is a trust boundary.
- Put a model in the recommendation path. Rules in `rules.ts` are readable and
  predictable on purpose; a model may later *narrate* a reason, never decide one.
- Add a dependency for something a few lines of stdlib does. The engine has four
  runtime dependencies.
- Add an abstraction with one implementation, or a config option for a value that
  never changes.
- Broad refactors bundled with behaviour changes. Separate PRs.

## Platform

Windows x64 is the supported and tested platform. macOS and Linux support is wanted
(roadmap item 1) but path resolution and packaging are not portable yet, do not add
a half-implemented platform branch that claims support the code does not have.
