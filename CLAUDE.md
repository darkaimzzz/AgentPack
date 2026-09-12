# CLAUDE.md — AgentPack HackBattle Build Brief

## 0. What this file is

You are working on **AgentPack**, a 36-hour hackathon project for **HackBattle — IEEE Computer Society, VIT Vellore**.

Read this file before making architectural or implementation decisions.

Your job is to help build a **working, polished, narrow golden-path demo**, not a broad prototype with half-working integrations.

---

# 1. Product in one sentence

**AgentPack is a cross-agent package manager for MCP servers and plugins that detects a developer's environment, recommends useful capability packs, installs and configures them across supported AI coding agents, validates that they actually work, and can roll the changes back.**

Best one-line defense:

> **We don't list tools — we install verified capability packs across your coding agents and prove they work.**

---

# 2. The problem

AI coding tools such as Claude Code, Codex, and OpenCode are becoming extensible through:

- MCP servers
- plugins
- agent integrations

But setup is fragmented.

Today a developer often has to:

1. search for the right MCP/plugin
2. read installation docs
3. check whether it works with their coding agent
4. install Node/Python/package dependencies
5. manually edit different config formats
6. add environment variables or credentials
7. restart/reload the agent
8. verify whether the integration actually works
9. repeat the entire process for another coding agent

The same capability may require different setup for Claude Code vs Codex vs OpenCode.

**AgentPack collapses that into one guided flow.**

---

# 3. What the user experiences

The user launches the desktop app.

AgentPack detects:

- which supported AI coding agents are installed
- the current project stack
- which MCPs/plugins are already configured

Example:

```text
Detected Agents
✓ Claude Code
✓ Codex
✓ OpenCode

Detected Project
Next.js
Supabase
PostgreSQL
GitHub repository
```

Then AgentPack recommends capabilities:

```text
Recommended Pack

✓ Supabase MCP
✓ GitHub integration
✓ Playwright MCP

Why?
- Supabase detected in package.json/config
- Git repository detected
- Next.js frontend detected, so browser/E2E tooling is useful
```

The user chooses a pack or individual capabilities and clicks:

```text
INSTALL SELECTED
```

AgentPack then:

1. determines the correct install method
2. checks dependencies
3. requests required secrets/credentials
4. backs up affected configs
5. runs installation commands in the background
6. writes agent-specific configuration
7. validates the installed integration
8. shows a clear success/failure report

Example result:

```text
Supabase MCP
Claude Code     ✓ Installed
Codex           ✓ Installed
OpenCode        ✓ Installed

Health check    ✓ Passed
Rollback        Available
```

The terminal complexity is hidden by default.

An **Advanced / Logs** drawer should show the real commands/output so technical judges can see that the system is genuinely doing work.

---

# 4. IMPORTANT: what AgentPack is NOT

Do NOT accidentally turn this into:

- an MCP marketplace
- a catalog/listing website
- a chatbot that tells users how to install MCPs
- an LLM wrapper
- a static collection of setup instructions
- "one-click install everything on Earth"

Discovery is secondary.

The hard, differentiating system is:

```text
DETECT
  ↓
RECOMMEND
  ↓
COMPILE UNIVERSAL CAPABILITY DEFINITION
  ↓
INSTALL
  ↓
WRITE AGENT-SPECIFIC CONFIG
  ↓
VALIDATE
  ↓
ROLLBACK IF NEEDED
```

If cross-agent installation/configuration does not genuinely work, the product collapses into a weak marketplace UI.

---

# 5. Hackathon track fit

Primary target:

**Developer Tooling → Workflow & Context Management**

Very strong secondary fit:

**Developer Tooling → Terminal & Shell Tooling**

Also relevant:

**AI & Automation → Agentic Workflows**

If permission/security features are implemented well:

**AI & Automation → Guardrails & Trust**

Do not force the Guardrails & Trust story unless we actually implement trust/permission functionality.

---

# 6. Platform decision

## We are building a Windows desktop app.

Reason:

AgentPack needs local access to:

- installed binaries
- PATH
- local project files
- agent configuration files
- child processes / shell commands
- environment configuration
- backups and rollback

A pure hosted web app cannot safely or conveniently do this.

## Recommended hackathon stack

**Electron + React + TypeScript + Vite**

Why Electron for this hackathon:

- fastest path for a JS/TS team
- direct Node.js filesystem/process access
- easy Windows desktop packaging
- easy React UI
- mature ecosystem
- no need to learn Rust during a 36-hour hackathon

Electron is heavier than Tauri. That does not matter for this hackathon.

Do NOT choose WinUI/.NET unless the team is already highly comfortable with it.

Do NOT choose Tauri merely because it is lighter if that introduces Rust/debugging risk.

Priority:

> reliability and development speed > bundle size

Suggested architecture:

```text
┌─────────────────────────────────────┐
│ React Renderer UI                   │
│                                     │
│ Dashboard                           │
│ Recommendations                     │
│ Install progress                    │
│ Health report                       │
│ Logs                                │
└─────────────────┬───────────────────┘
                  │ IPC
┌─────────────────▼───────────────────┐
│ Electron Main Process               │
│                                     │
│ Agent Detector                      │
│ Project Scanner                     │
│ Recommendation Engine               │
│ Registry                            │
│ Installer Engine                    │
│ Config Adapters                     │
│ Health Checks                       │
│ Backup / Rollback                   │
└─────────────────┬───────────────────┘
                  │
     ┌────────────┼────────────┐
     ▼            ▼            ▼
Claude Code     Codex       OpenCode
configs/CLI     configs      configs
```

The renderer should NEVER directly execute arbitrary shell commands.

All privileged filesystem/process operations belong in the Electron main process behind explicit IPC methods.

---

# 7. Golden-path scope

The number-one rule:

> **A narrow path that works perfectly beats broad support that breaks live.**

Target maximum:

- **2–3 coding agents**
- **~5 integrations**
- **2 curated packs**
- **1 controlled demo repository**
- **1 polished install path**
- real backup
- real validation
- real rollback

Preferred agents:

1. Claude Code
2. Codex
3. OpenCode only if time permits

Preferred capabilities/integrations should be selected based on what is easiest to install reliably and visibly demonstrate.

Candidate set:

- GitHub
- Supabase
- Playwright
- PostgreSQL
- one additional low-friction MCP/plugin

Do not lock the fifth integration until installation complexity is tested.

---

# 8. Capability abstraction

The product supports **plugins + MCPs**.

Do not use "MCP-only" language in core architecture.

Internally, treat both as a generic:

> **Capability**

Example capability definition:

```ts
type Capability = {
  id: string
  name: string
  type: "mcp" | "plugin"
  description: string
  supportedAgents: string[]
  requirements?: {
    environmentVariables?: string[]
    binaries?: string[]
    runtimes?: string[]
  }
  install: {
    method: "npm" | "npx" | "pip" | "command" | "manual"
    command?: string
  }
  permissions?: string[]
  healthCheck?: HealthCheckDefinition
}
```

The exact schema can evolve. Keep it simple.

---

# 9. Universal manifest / compiler idea

One of the strongest technical parts is that the same logical capability can be installed into different agents.

Concept:

```yaml
pack:
  name: fullstack-starter

capabilities:
  - supabase
  - github
  - playwright

targets:
  - claude-code
  - codex
```

AgentPack translates this universal intent into agent-specific config.

Conceptually:

```text
Universal Pack Manifest
          ↓
    Adapter Layer
   /      |       \
Claude   Codex   OpenCode
 config   config   config
```

Each supported agent gets an adapter.

Possible interface:

```ts
interface AgentAdapter {
  detect(): Promise<AgentDetectionResult>
  getVersion(): Promise<string | null>
  readConfig(): Promise<unknown>
  backupConfig(): Promise<BackupResult>
  installCapability(capability: Capability, context: InstallContext): Promise<InstallResult>
  validateCapability(capability: Capability): Promise<HealthResult>
  rollback(backup: BackupResult): Promise<RollbackResult>
}
```

Do not over-engineer this.

The goal is to prove that adding another agent is an adapter problem, not a rewrite of the app.

---

# 10. Agent detection

Detection is intentionally limited to supported clients.

Use multiple signals when useful:

- executable exists on PATH
- known config directory exists
- version command succeeds
- known installation directory exists

If an installation is non-standard, surface that clearly rather than silently guessing.

---

# 11. Project stack detection

Keep recommendations deterministic.

Scan common files such as:

```text
package.json
package-lock.json
pnpm-lock.yaml
requirements.txt
pyproject.toml
Dockerfile
.env.example
next.config.*
vite.config.*
supabase/
prisma/
.git/
```

Examples:

```text
If @supabase/supabase-js exists
→ recommend Supabase capability

If .git exists
→ recommend GitHub capability

If Next.js or frontend framework detected
→ recommend Playwright/browser testing capability
```

Use simple rules.

Do not make the hackathon depend on an LLM correctly inferring the stack.

Optional AI may explain recommendations in natural language, but should not control the golden path.

---

# 12. Installation engine

Each installation should be a sequence of explicit steps.

```text
1. Preflight
2. Credential check
3. Config backup
4. Dependency installation
5. Capability install
6. Agent config mutation
7. Validation
8. Commit success state
```

UI should show progress clearly.

If a step fails, show the exact stage and offer retry/rollback.

---

# 13. Background commands

Commands should run in the background from the Electron main process.

Use Node process APIs such as:

```ts
spawn()
execFile()
```

Prefer `spawn` / `execFile` over raw `exec` where possible.

Capture:

- stdout
- stderr
- exit code
- execution time

Send sanitized progress events to the renderer.

The user does NOT need to see a terminal window.

But the UI should expose an optional log view so judges can verify that real commands are executing.

---

# 14. Secrets and credentials

Never print secrets in logs.

Never persist secrets unnecessarily.

Hackathon minimum:

1. detect required variables
2. ask user for missing values
3. keep them in memory where possible
4. inject only into the process/config that needs them
5. redact them in logs

Do not claim enterprise-grade secret management.

---

# 15. Backup + rollback

Rollback is a P0 feature.

Before modifying an agent config, create a timestamped backup.

Track exactly:

- files modified
- config keys added
- backup paths

Minimum rollback requirement:

> restore original agent config files

If package uninstallation is safe and deterministic, also undo installed dependencies.

Do not claim perfect machine-state rollback if we only restore configuration.

---

# 16. Health checks

Do not call something "installed" merely because a command exited successfully.

Minimum checks:

- config entry exists
- referenced command/binary exists
- MCP server process can start
- expected endpoint/process responds
- agent-side tool listing confirms capability, if supported

Be explicit when a deeper validation is unavailable.

---

# 17. Packs

A Pack is a named bundle of capabilities.

MVP example:

## Full-Stack Pack

```text
Supabase
GitHub
Playwright
```

Packs should be stored as data, not hard-coded into React components.

---

# 18. Core screens

## Screen 1 — Welcome / Detect

Show detected agents and a Scan Project action.

## Screen 2 — Project Analysis

Show detected stack and why.

## Screen 3 — Recommendations

Each card should show:

- name
- MCP or Plugin
- why recommended
- supported agents
- broad permissions
- requirements

## Screen 4 — Install Plan

Show exactly what will be changed before execution.

## Screen 5 — Install Progress

This is a major demo screen. Make it feel alive and trustworthy.

## Screen 6 — Success / Health Report

Show a matrix of capability × agent health, plus logs/export/rollback.

---

# 19. Export / reproducibility

If time permits, export the installed set as a reusable manifest.

This gives a strong story:

> configure once, reproduce elsewhere

Do NOT attempt cross-machine secret synchronization.

---

# 20. UI direction

The UI should be:

- dark
- clean
- developer-focused
- minimal
- obvious status indicators
- easy to demo from a distance

Avoid spending hours on animations.

Priority:

1. installer works
2. validation works
3. rollback works
4. UI makes those systems visible
5. polish after

---

# 21. Security posture

Because AgentPack installs third-party software, show trust information before install.

Minimum:

- source / publisher
- install method
- required environment variables
- broad permissions
- supported agents

For the hackathon, use a **curated allow-listed registry**.

Do not implement an open community marketplace.

---

# 22. What makes this technically interesting

Technical depth is NOT:

> "We have a nice list of MCPs."

Technical depth is:

- local agent detection
- project stack detection
- universal capability manifest
- agent-specific adapters
- safe config mutation
- process orchestration
- background installation
- permission/requirement modeling
- secret redaction
- health checks
- backups
- rollback
- reusable pack manifests

---

# 23. Demo story

Target roughly 90–120 seconds.

1. Explain fragmented setup.
2. Launch AgentPack.
3. Detect Claude Code + Codex.
4. Detect a Next.js + Supabase repo.
5. Recommend Supabase + GitHub + Playwright.
6. Click Install.
7. Show real backup/install/config/validation progress.
8. Open at least one actual coding agent and prove a capability works.
9. Ideally prove a second agent also received the capability.
10. Show rollback is available.

Final line:

> We don't list tools — we install verified capability packs across your coding agents and prove they work.

---

# 24. Success criteria

The build is successful if:

- AgentPack launches reliably on the demo Windows machine
- detects at least 2 supported coding agents
- detects the demo project stack
- recommends relevant capabilities deterministically
- installs at least 3 real capabilities
- configures at least 2 coding agents
- preserves config backups
- provides useful progress/error output
- validates installation
- can restore original config
- demo can be repeated without manual repair

If these work, STOP ADDING CORE FEATURES and polish.

---

# 25. Non-goals for the 36-hour build

Do not spend core build time on:

- macOS support
- Linux support
- dozens of coding agents
- dozens of MCP servers
- public marketplace
- ratings/reviews
- publishing system
- account system
- cloud synchronization
- enterprise admin console
- perfect secret vault
- billing
- teams
- advanced policy engine
- AI chat interface
- auto-generated arbitrary MCP installation recipes

These can be future roadmap items.

---

# 26. Build priority

## P0 — must work

- Electron Windows app
- agent detection
- project detection
- small curated registry
- capability/pack model
- install engine
- Claude adapter
- Codex adapter
- background commands
- config backup
- config writing
- logs
- validation
- rollback
- clean install progress UI

## P1 — after golden path works

- OpenCode adapter
- pack export/import
- richer trust/permission information
- install conflict detection
- "repair setup"
- better health checks
- nicer polish

## P2 — only if everything else is done

- LLM-generated recommendation explanation
- larger registry
- community features
- analytics
- accounts/cloud features

---

# 27. Suggested repository structure

```text
agentpack/
├─ electron/
│  ├─ main.ts
│  ├─ preload.ts
│  ├─ ipc/
│  └─ core/
│     ├─ agents/
│     ├─ capabilities/
│     ├─ detection/
│     ├─ installer/
│     └─ recommendations/
├─ src/
│  ├─ App.tsx
│  ├─ pages/
│  ├─ components/
│  ├─ hooks/
│  └─ types/
├─ registry/
│  ├─ capabilities/
│  └─ packs/
├─ package.json
└─ CLAUDE.md
```

This is a suggestion, not a mandate.

If the implementation already has a cleaner structure, preserve it.

---

# 28. Coding rules for Claude Code

When helping build this project:

1. Inspect existing files before replacing them.
2. Do not invent APIs/config formats for Claude/Codex/OpenCode.
3. Verify commands locally where possible.
4. Prefer small working increments.
5. Preserve the golden path.
6. Do not add dependencies unless they materially help.
7. Keep privileged operations in Electron main.
8. Validate filesystem paths before writing.
9. Back up configs before mutation.
10. Never log secrets.
11. Return structured errors to the UI.
12. Do not hide failed health checks.
13. Avoid broad refactors during final demo prep.
14. If unsure whether a feature is worth building, prioritize install reliability.
15. Do not turn this into a marketplace.

---

# 29. Decision rule during the hackathon

Whenever deciding between two features, ask:

> Does this make the live cross-agent install path more reliable, more credible, or easier to understand?

If yes, prioritize it.

If not, defer it.

---

# 30. Current product positioning

Bad:

> An app store for MCPs.

Better:

> One-click MCP/plugin installer.

Best:

> **A cross-agent package manager for AI coding capabilities.**

Expanded:

> AgentPack detects your coding agents and project stack, recommends compatible MCPs and plugins, compiles one capability definition into each agent's configuration, installs them, validates the result, and provides rollback.

---

# 31. Current biggest risk

The project fails if the UI looks polished but cross-agent installation is fake, incomplete, or unreliable.

Therefore build order is:

```text
working adapter
→ working install
→ working config write
→ working health check
→ working rollback
→ SECOND agent
→ UI polish
→ extra integrations
```

NOT:

```text
beautiful marketplace
→ lots of cards
→ animations
→ fake progress
→ eventually try installation
```

---

# 32. Immediate first task tomorrow

Before building UI:

1. create the Electron + React + TypeScript shell
2. verify Node child-process execution from Electron main
3. detect Claude Code
4. detect Codex
5. locate/read their real config
6. manually prove one chosen MCP/plugin can be installed into BOTH
7. only then formalize the adapter abstraction

This experiment determines whether the core product is viable.

If cross-agent installation is much harder than expected, reduce the integration count immediately rather than faking support.

---

# 33. Final reminder

HackBattle is 36 hours.

We are not building the final global ecosystem.

We are proving one powerful idea:

> **A developer should be able to choose the capabilities they want once, and AgentPack should safely equip multiple AI coding agents for them without manual configuration.**

Make that one experience feel impossibly smooth.
