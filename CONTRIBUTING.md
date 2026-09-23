# Contributing to AgentPack

Thanks for taking the time. This document covers the three things people usually want to do, add a capability, add an agent, or fix a bug, and the bar a change has to clear.

## The one rule

**AgentPack does not claim things it has not observed.** Health status distinguishes *verified* (the server started and answered `tools/list`) from *configured* (written correctly, but unobservable from here). Context figures say *estimated*. Rollback refuses rather than guesses when it cannot prove what it wrote.

A change that makes the app claim more than it can demonstrate will not be merged, however convenient the claim is. If you find somewhere the app already overclaims, that's a bug worth filing.

## Setup

Requires **Node.js 22.17+** with npm on PATH. The engine uses Node's native TypeScript type stripping, so most of it runs without a build step.

```powershell
git clone https://github.com/darkaimzzz/AgentPack.git
cd AgentPack
npm ci
npm run dev       # Electron + Vite, hot reload
```

Work against the sandbox, not your real config:

```powershell
npm run demo                      # isolated sandbox, sample agents + project
$env:AGENTPACK_HOME = "C:\tmp\ap" # or redirect configs and state anywhere
```

Environment variables that matter while developing:

| Variable | Effect |
| --- | --- |
| `AGENTPACK_HOME` | Redirects agent configs *and* AgentPack state into an isolated directory |
| `AGENTPACK_DEMO=1` | Demo sandbox mode |
| `AGENTPACK_REGISTRY` | Load the registry from elsewhere |
| `AGENTPACK_NO_BOOT=1` | Skip the startup sequence (`AGENTPACK_BOOT=1` forces it on) |
| `AGENTPACK_SMOKE=1` | Headless wiring check; the app self-exits |

## Adding a capability

A capability is a JSON file in `registry/capabilities/`. No code changes.

**MCP server:**

```json
{
  "id": "filesystem",
  "name": "Filesystem",
  "type": "mcp",
  "description": "Read, write and search files within an explicitly allowed directory.",
  "source": "Anthropic, npm @modelcontextprotocol/server-filesystem",
  "install": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "${projectDir}"]
  },
  "supportedAgents": ["claude", "codex", "opencode"]
}
```

**Marketplace plugin:**

```json
{
  "id": "superpowers",
  "name": "Superpowers",
  "type": "plugin",
  "description": "Feature-development workflow skills.",
  "source": "Anthropic, github anthropics/claude-plugins-official",
  "plugin": {
    "marketplace": "claude-plugins-official",
    "repo": "anthropics/claude-plugins-official",
    "name": "superpowers"
  },
  "supportedAgents": ["claude", "codex"]
}
```

The full shape is `Capability` in [`electron/core/types.ts`](electron/core/types.ts). Optional fields worth knowing:

- `secrets`: env vars the user must supply. Values never enter the registry, the ledger, or an export.
- `inputs`: non-secret values substituted into args as `${KEY}`. `${projectDir}` is built in.
- `requires.binaries`: external CLIs the capability needs. Checked up front so a hollow success isn't reported.
- `triggers`: file globs that reactivate the capability when matched. `file_glob` is the only type.

### Requirements for a new capability PR

1. **Pin an exact version.** `@pkg@1.2.3`, never `@latest`. Health checks rely on the pinned version being cacheable.
2. **Launch it yourself and paste the tool list in the PR.** `npm run cli -- install --pack …` then `npm run cli -- clm measure`, or run the server by hand. A capability that has not been observed answering `tools/list` does not go in the registry.
3. **Name a real publisher** in `source`. "Someone on npm" is not a publisher.
4. **Say which agents you actually tested it in.** `supportedAgents` is a claim, not an aspiration, OpenCode in particular rejects things Claude Code accepts.

To have it *recommended* rather than merely available, add a rule in [`electron/core/recommendations/rules.ts`](electron/core/recommendations/rules.ts):

```ts
{
  capabilityId: 'playwright',
  anyOf: ['nextjs', 'vite', 'cypress'],   // any matching project signal
  because: 'A frontend was detected, so browser and E2E tooling helps, {evidence}.',
}
```

Rules are deterministic and readable on purpose. No model decides a recommendation; `{evidence}` is substituted with the signal that actually matched, so the UI can show its reasoning.

A pack is a named list in `registry/packs/`; a profile is a list in `registry/profiles/`.

## Adding an agent

Roughly 60 lines plus a type change. Implement `AgentAdapter` from [`electron/core/agents/adapter.ts`](electron/core/agents/adapter.ts):

```ts
configPath()   // where this agent keeps MCP config
detect()       // multiple signals, binary on PATH, config dir, version command
read(cap)      // normalise the native entry to ConfigEntry, or null
write(cap, env)
remove(cap)
isEmpty()
validate()     // must NOT swallow parse errors, this is how callers tell
               // "broken config" apart from "no entries"
```

Optional, and worth implementing where the format supports it:

- `setEnabled(cap, enabled)`: if the format has a native enabled flag. Its presence switches dormancy from remove-and-stash to a one-field flip, which never touches credentials and is strictly safer.
- `restoreEntry(cap, entry)`: lossless restore of the full native object, for formats where `ConfigEntry` loses fields.
- `readPlugin` / `writePlugin` / `removePlugin`, only for agents with a git-marketplace plugin model. Leave undefined otherwise; `supportsType()` handles the rest.

Then add the key to `AgentKey` in `types.ts` and to the `adapters` map in `agents/index.ts`.

**Writing config is the dangerous part.** Three things are not negotiable:

- **Write atomically**: use `atomicWrite` from `electron/core/files.ts` (temp file + rename, mode 0600). Never a partial write to a file an agent may be reading.
- **Edit surgically.** Do not re-serialize the whole document. TOML and JSONC carry user comments, and a round-trip through a parser deletes them. Splice the table or key.
- **Never guess.** If the document is shaped in a way the adapter can't edit safely, throw. A refusal the user can act on beats a config they have to repair.

## Bugs and tests

Reproduce before fixing. Every regression test in this repo reproduces the original failure rather than asserting the fix, see [`electron/core/review-v160.test.ts`](electron/core/review-v160.test.ts) for the pattern. Tests use `node:test` and `node:assert/strict`, a temp `AGENTPACK_HOME` per case, no framework.

New test files go in `package.json`'s `test` script.

## Checks

```powershell
npm run typecheck   # must be clean
npm test            # deterministic fixture regressions
```

Those two run in CI on every PR and must pass. The rest need network access or a desktop session, so run them locally when your change touches those areas:

| Command | Covers | Needs |
| --- | --- | --- |
| `npm run check` | engine self-checks | network (launches real MCP packages) |
| `npm run e2e` | engine acceptance, byte-identical rollback | network |
| `npm run test:ui` | built renderer, preload, IPC | desktop session |
| `npm run test:tools` | three real `tools/call` round trips | network |
| `npm run smoke` | fresh sandbox, app wiring | desktop session |

On a machine where the npm registry certificate fails to validate, health checks fall back to the npx cache (`npm_config_prefer_offline`) rather than retrying for ~70 seconds per launch. If probes are inexplicably slow, check `npm ping` before blaming the code.

## Pull requests

- One concern per PR. Refactors separate from behaviour changes.
- Say what you ran, and paste the output. "Tests pass" without the output is not evidence.
- Note anything you *couldn't* verify. That's useful information, not a weakness.
- Match the surrounding style: comments explain *why*, not what. Existing comments frequently record a bug that was hit, don't delete those.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
