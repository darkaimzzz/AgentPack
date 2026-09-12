# Demo workflow

The complete run-through for HackBattle: preparation, a five-minute script with exact
clicks, the Capability Load Manager walkthrough, judge questions, and a failure playbook.

**The claim being demonstrated:** *We don't list tools — we install verified capability
packs across your coding agents, show what they cost you in context, and prove they work.*

Three things have to land:

1. **Cross-agent install is real.** One selection becomes three different native config
   formats: JSON, TOML and JSONC.
2. **Validation is real.** The MCP servers are actually launched and actually answer
   `tools/list`. Nothing is called installed because a command exited 0.
3. **It is reversible.** Rollback restores the original bytes and refuses to clobber
   edits it does not own.

The Capability Load Manager is the fourth beat, and the one that separates this from an
installer: *installed is not the same as loaded*, and you can see the price.

---

## Part 1 — Machine preparation (30 minutes early)

Requires Windows x64 and **Node.js 22.17+ with npm on PATH**. The portable executable
bundles Electron but still uses the machine's Node to launch MCP servers.

```powershell
npm ci
npm run cli -- prewarm playwright filesystem sequential-thinking context7
npm run test:tools
```

`prewarm` downloads each MCP package into the npx cache and confirms it answers
`tools/list`. Do this on the venue network. Expect one line per server ending in a tool
count; every line must be green.

`test:tools` makes three real `tools/call` requests — Filesystem reads a sentinel file,
Playwright opens and closes `about:blank`, Sequential Thinking returns a terminal step.
If Playwright reports a missing browser, run `npx playwright install chromium`.

Confirm the build you will present from:

```powershell
npm run build          # or use release\AgentPack-2.0.0-win-x64.exe
```

**Do not demo without `--demo`.** Without it, AgentPack reads and writes your real agent
configuration.

---

## Part 2 — Dry run (5 minutes early, then leave the app open)

```powershell
npm run demo
```

Every launch creates a **fresh sandbox** in the temp directory: three empty agent configs
and a nested Next.js + Supabase project. That freshness is the point — but it also means
**measured context costs do not survive a relaunch**.

So: do one full dry run, click **Measure context cost** on the Manage screen, then roll back and
**leave the window open**. Measurement is cached for the life of that sandbox, so the live
run will not spend twenty seconds probing servers in front of the judges. If you must
relaunch, budget for re-measuring.

---

## Part 3 — The five-minute run

### 0:00 — Act 1 · The problem, on screen

The device opens, its screen lights with the logo, and the camera pulls back to leave that
logo sitting in the app's own header. It runs about two and a half seconds; **any click or
keypress skips it**, which is what you want on the third run of the day. Detection is already
running underneath, so it costs no startup time.

The first screen then shows three detected agents. Point at them.

> "Claude Code, Codex and OpenCode are all extensible through MCP servers and plugins.
> They also all store that configuration differently — `~/.claude.json` is JSON,
> `~/.codex/config.toml` is TOML, OpenCode uses JSONC with comments. Adding one capability
> to all three today means editing three files by hand, three times, and hoping."

Point at the **Configure these agents** checkboxes below the list.

> "You pick the targets. AgentPack only touches the agents you tick."

---

### 0:40 — Act 2 · Detection with evidence

Click **Scan demo project**.

The demo project is deliberately awkward: a monorepo root whose `package.json` declares
workspaces, with Next.js and Supabase living down in `apps/web`. Naive detection reads the
root `package.json`, finds nothing, and says "Node.js".

Point at the evidence column.

> "Next.js — because `apps/web/next.config.ts` exists. Supabase — because
> `apps/web/package.json` depends on `@supabase/ssr`, and there's a `supabase/config.toml`
> next to it. Every signal carries the file that produced it. No model guessed this; these
> are deterministic rules, so the demo behaves the same way every time."

Click **Continue**.

---

### 1:20 — Act 3 · Choose and review

On **Choose capabilities**:

1. Click the **Local Developer** pack card — Playwright, Filesystem, Sequential Thinking.
   No API keys.
2. Tick **Context7** in the MCP tab. *(You need it for the profile demo in Act 5. Click the
   pack first — a pack click replaces the whole selection.)*
3. Switch to the **Plugin** tab and tick **Superpowers**.

> "Packs are data in the registry, not hard-coded screens. The plugin is here on purpose —
> plugins and MCP servers are the same thing to this engine, a *capability*, and they
> compile down to whatever each agent's format needs."

Click **Review plan**.

> "Before anything is written: exactly what gets installed, the real command each server
> runs, which file each change lands in, and which agents can host it. Superpowers is
> Claude Code and Codex only — OpenCode uses a different plugin system, so AgentPack says
> *not supported* instead of pretending."

---

### 2:00 — Act 4 · Install, and prove it

Click **Install selected**. Open the log drawer while it runs.

> "Preflight first — runtimes and binaries — so a missing Node is one clear message rather
> than three cryptic spawn failures. Then backups, then config writes, then validation."

When the report lands, drive the health matrix:

> "This green tick is not 'the command exited zero'. AgentPack spawned each server over
> stdio, completed the MCP handshake and read back its tool list. Playwright answered with
> 24 tools, Filesystem 14, Sequential Thinking 1 — those numbers came off the wire just
> now."
>
> "Superpowers says **Configured**, not Verified — deliberately. A plugin loads inside the
> agent process; we can prove the config is right, and we can't prove more than that from
> out here, so we don't claim it."

If you have a terminal handy, this is the strongest single moment available:

```powershell
type $env:TEMP\agentpack-demo-*\.codex\config.toml
```

> "Same capability. TOML tables for Codex, an `mcpServers` object in Claude's JSON, an
> `mcp` block in OpenCode's JSONC — written surgically, so the rest of each file is byte
> for byte untouched."

---

### 3:00 — Act 5 · The Capability Load Manager

Click **Manage** in the header. This is the differentiator — give it a full minute.

**The summary bar.** Three numbers: **Active tools**, **Estimated context**, **Estimated
reduction**. With the Local Developer pack installed, our tested run reads
**39 tools · ~9,000 estimated tokens**.

> "Every active MCP server ships its complete tool schemas — names, descriptions, JSON
> input schemas — into the agent's context at the start of every session. You pay for all
> of it whether or not the task needs a browser. That number is measured, not guessed: it's
> the serialized `tools/list` response, characters divided by four. An estimate of schema
> size, not billed tokens — and the screen says exactly that."

*(If the screen says **Context cost not measured yet**, click **Measure context cost** — that
launches each server for real, about four seconds each. It should already be done from the dry
run; measurements do not survive a relaunch.)*

**One capability, one agent.** Find the Playwright row and click **Deactivate · Codex**.

> "Watch the summary. Twenty-four tools and their schemas just left Codex's next session.
> Nothing was uninstalled — the package is still on disk, and for Codex this is the native
> `enabled = false` flag in its own TOML, not a deletion. Claude Code has no such flag, so
> there we save the full entry, credentials included, into a local store and take it out of
> the live config. Either way, one click brings it back exactly as it was."

Click **Activate · Codex** to show it return.

**Profiles.** Click **Frontend**.

> "Frontend means Playwright, Filesystem and Context7 — Sequential Thinking goes dormant.
> One click, a real diff computed against the live config, applied per agent. If any part
> of it failed you'd get *Partly applied* with the reason, never a green tick over a config
> that isn't what you asked for."

Click **Minimal**.

> "Nothing loaded. Active tools zero, reduction 100%. The cheapest possible context for
> focused work — and every capability is still installed, one click away."

Click **Frontend** again to restore.

**Automatic activation.** Click **Watch a project…** and pick the demo project folder.
Then, in a terminal:

```powershell
ni $env:TEMP\agentpack-demo-*\next-supabase-app\apps\web\checkout.spec.ts
```

A banner appears within a second or two: Playwright enabled for the next agent session,
naming the file and the `**/*.spec.ts` pattern that matched.

> "You don't have to manage this by hand. A test file appears, the browser tooling comes
> back automatically. One trigger mechanism — file patterns declared in the registry — not
> a background model making decisions about your machine."

**The honest caveat — say it before a judge asks:**

> "These changes are written to the live config and backed up first, but Claude Code reads
> MCP configuration at session start and exposes no hot-reload. So this is not hot-swapping
> a running agent. It's choosing what your *next* session carries. The footer on this
> screen says that too."

---

### 4:00 — Act 6 · Undo

Back to **Install**, click **Roll back**.

> "Every change is undoable. AgentPack snapshots each config before touching it and keeps a
> ledger under `~/.agentpack`."

Show the config again — back to the original bytes.

> "And it's ownership-aware, which matters more than it sounds. Rollback compares before,
> after and current, entry by entry. Something you added afterwards survives. If you edited
> an entry AgentPack installed, it refuses and tells you rather than silently overwriting
> your work. A rollback that eats your config is worse than no rollback."

---

### 4:40 — Close

> "Detect the agents. Detect the stack, with evidence. Compile one capability definition
> into three native formats. Launch the servers and prove they answer. Show what they cost
> you in context and let you switch that off without uninstalling anything. Undo all of it.
>
> Adding a fourth agent is an adapter, not a rewrite.
>
> We don't list tools — we install verified capability packs across your coding agents and
> prove they work."

---

## The 60-second version

If you get cut short, do exactly this:

1. **Scan demo project** → point at the nested Next.js/Supabase evidence. (10s)
2. **Local Developer** → **Review plan** → **Install selected** → point at the health
   matrix. "These servers were launched and answered `tools/list`." (25s)
3. **Manage** → **Minimal** → "39 tools of schema, gone from the next session. Nothing
   uninstalled." (15s)
4. **Roll back**. "All of it reversible." (10s)

---

## Judge questions, with honest answers

**"Is this just a wrapper around `claude mcp add`?"**
No. `claude mcp add` configures one agent. AgentPack compiles one capability definition
into three different native formats, validates the result by launching the server, and
tracks ownership so it can undo the change safely. Codex and OpenCode have no equivalent
command at all.

**"Did it really install, or is the UI faking it?"**
Open the config files — they're on disk in the sandbox. The tool counts in the health
report came from live `tools/list` responses; `npm run test:tools` goes further and makes
real `tools/call` requests.

**"Are those real token counts?"**
They're estimates of tool-schema size — the serialized `tools/list` response divided by
four — measured once per installed capability. Not billed tokens, and a given agent may
load tools differently. The screen says so.

**"Does deactivating free context in a running session?"**
No, and we don't claim it. Claude Code reads MCP config at session start and has no disable
command or hot-reload. This changes what your next session loads.

**"What about secrets?"**
Credentials stay out of progress logs, the install ledger, exported manifests and
measurement metadata — there are tests pinning that. They are still present in the agent
config files, the config backups and the dormant store, because that's where the agent
needs them; we say so rather than claiming a vault.

**"Can I trust it with my real config?"**
It backs up before every write, refuses to write a config it just made invalid, stops if
another process edits the file mid-install, and writes atomically. Rollback is
ownership-aware and refuses conflicts instead of guessing. `AGENTPACK_HOME` sandboxes
everything if you want to try it without risk.

**"What isn't done?"**
Authenticated GitHub/Supabase operations haven't been exercised with real accounts, and we
haven't started a coding-agent session and watched it load the generated config — so plugin
status says *Configured*, never *Verified*. The Windows build is unsigned. See
[READINESS.md](READINESS.md) for the full scored assessment.

---

## Failure playbook

| Symptom | Fix |
| --- | --- |
| "Node.js and npm were not found on PATH" | Install Node 22.17+, then **restart AgentPack** so it inherits the new PATH. |
| Server download or startup times out | Rerun `prewarm` on a working connection. Read the error out loud; never describe a failed server as installed. |
| Every server takes over a minute to start | The npm registry is unreachable or its certificate will not validate, and npm retries for ~70s before using its cache. AgentPack asks npm to prefer the cache for pinned versions, so this should not happen — but if it does, check `npm ping` and the machine clock. A clock set far ahead makes valid certificates read as expired. |
| Playwright launches nothing | `npx playwright install chromium`. |
| Config conflict during install | Expected behaviour — the entry already exists with different settings. Say so: AgentPack leaves it alone rather than overwriting. |
| Rollback conflict after a dormancy toggle | Reactivate that capability in **Manage**, then retry rollback. |
| Manage shows "Context cost not measured yet", or `—` in place of numbers | Click **Measure context cost**; allow ~20 seconds. Nothing is broken — cost is measured once per capability, and measurements do not survive a relaunch. |
| Anything unrecoverable | Close the window, relaunch with `--demo` — a brand new sandbox. Budget 30 seconds to re-measure. |

---

## Rules for the presenter

- Never say "verified" about a plugin. Say **configured**.
- Never say "tokens saved". Say **estimated context**.
- Never say "live" about a dormancy change. Say **next session**.
- If something fails on stage, read the real error aloud. The product's whole argument is
  that it tells you the truth about your machine — a bluff on stage undoes the pitch.
