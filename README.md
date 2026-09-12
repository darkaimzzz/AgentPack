# AgentPack

**A cross-agent package manager for AI coding capabilities.**

> We don't list tools — we install verified capability packs across your coding agents and prove they work.

AgentPack detects which AI coding agents you have installed and what your project is built
with, recommends compatible MCP servers, compiles **one** capability definition into **each
agent's native config format**, installs it, validates that the server actually runs, and
can roll every change back.

Built for HackBattle — IEEE Computer Society, VIT Vellore.

---

## The problem

Adding one MCP server to your toolchain today means: find it, read its docs, check agent
compatibility, install runtimes, hand-edit a config file in whatever format that agent uses,
supply credentials, restart the agent, and then hope it worked. Repeat per agent.

The same capability needs different setup for Claude Code, Codex and OpenCode — because they
genuinely store it differently:

| Agent | Format | Servers key | Command | Env key |
|---|---|---|---|---|
| **Claude Code** | JSON | `mcpServers` | `command` + `args[]` | `env` |
| **Codex** | TOML | `[mcp_servers.x]` | `command` + `args[]` | `[…x.env]` subtable |
| **OpenCode** | JSON | `mcp` | `command[]` — **exe and args merged** | `environment` |

That third row is why this is a compiler and not a find-and-replace: OpenCode merges the
executable and its arguments into a single array and renames the env key. AgentPack's
adapter layer is the translation between them.

---

## How it works

```
DETECT  →  RECOMMEND  →  COMPILE  →  INSTALL  →  VALIDATE  →  ROLLBACK
```

1. **Detect** — which supported agents are installed, and where they keep their config.
2. **Scan** — read `package.json` and marker files to identify the project stack.
   Deterministic rules only; no LLM decides what you get.
3. **Compile** — turn one `Capability` into each agent's native config shape.
4. **Install** — back up every config first, then write.
5. **Validate** — start the MCP server over stdio and ask it `tools/list`.
   This is the part that matters: it proves the capability *works*, not that a file parsed.
6. **Rollback** — restore the backed-up configs, byte for byte.

---

## Quickstart

Requires **Node 22+** (the engine is TypeScript run natively — no build step).

```bash
git clone https://github.com/darkaimzzz/AgentPack.git
cd AgentPack
npm install

# which agents do I have?
node electron/core/cli.ts detect

# what's in this project, and what would you recommend?
node electron/core/cli.ts scan

# install a pack across every detected agent
node electron/core/cli.ts install --pack fullstack

# undo the last run
node electron/core/cli.ts rollback
```

Run the engine's self-checks:

```bash
npm run check
```

### Trying it safely

`AGENTPACK_HOME` redirects every config path into a sandbox, so you can exercise the whole
flow without touching your real agent configs:

```bash
mkdir -p /tmp/sandbox/.codex /tmp/sandbox/.config/opencode
cp ~/.claude.json /tmp/sandbox/
AGENTPACK_HOME=/tmp/sandbox node electron/core/cli.ts install --pack fullstack
```

This is also how development and demo rehearsal should run — writing `~/.claude.json` while
a Claude Code session is open risks a lost update, because that process owns the file.

---

## Registry

Capabilities and packs are **data**, not code — `registry/capabilities/*.json` and
`registry/packs/*.json`. The registry is curated and allow-listed on purpose; this is not an
open marketplace.

```json
{
  "id": "playwright",
  "name": "Playwright",
  "type": "mcp",
  "source": "Microsoft — npm @playwright/mcp",
  "install": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless"] },
  "supportedAgents": ["claude", "codex", "opencode"]
}
```

Capabilities may declare:

- **`inputs`** — non-secret values substituted into args as `${KEY}` (e.g. a Supabase project
  ref). Safe to record and to share in a pack manifest.
- **`secrets`** — environment variables the user supplies. Kept in memory, injected only
  where needed, and redacted from logs.

| Capability | Credentials | Tools |
|---|---|---|
| `playwright` | none | 24 |
| `github` | one PAT | 26 |
| `filesystem` | none | 14 |
| `supabase` | project ref + token | 13 |
| `sequential-thinking` | none | 1 |

---

## Layout

```
electron/
  core/
    agents/         adapter per agent — the translation layer
    capabilities/   registry loader, ${...} resolution
    detection/      project stack scanning
    recommendations/ deterministic signal → capability rules
    installer/      backup, install orchestration, health probe, ledger
    cli.ts          headless driver — the UI is just another caller
    selfcheck.ts    assert-based tests, run in a temp sandbox
registry/           capability + pack data
spike/              Phase 0 viability experiment, kept for reference
```

---

## What it does not claim

Honesty matters more than a clean demo, so:

- **A green health check proves the server runs, not that your credential is valid.**
  Several MCP servers answer `tools/list` happily with a fake token; auth is only checked on
  a real call. Credentialed capabilities are reported as
  *"server reachable; credential not verified"*.
- **Credentials do land in the agent config files.** That is how MCP servers receive them.
  What AgentPack guarantees is that secrets stay out of its own ledger and its own logs.
  This is not a secret vault.
- **Rollback restores configuration**, not machine state. It does not un-download an npm
  package or undo anything outside the config files it backed up.

---

## Status

| Phase | |
|---|---|
| 0 — Viability spike | ✅ |
| 1 — Engine: registry, adapters, install, health, rollback | ✅ |
| 2 — Project detection + recommendations | ✅ |
| 3 — Electron desktop UI | 🔨 |
| 4 — Rehearsal + polish | — |

Windows desktop is the target platform; the engine itself is platform-neutral.
