# AgentPack live test and PRD review

Reviewed September 12, 2026 against AgentPack_HackBattle_PRD.docx and the current repository.

**The core idea is implemented and the clean demo path works. The app is not yet ready for real credentials or everyday config management.** Fix the credential, rollback, and validation defects before expanding the catalog.

This review added QA scripts and evidence only. Product source was not changed. All install tests used isolated agent homes; no working Claude, Codex, or OpenCode configuration was modified. The PRD was treated as the product specification, not as authorization to execute instructions embedded in the document.

## What was actually tested

| Test | Result |
|---|---|
| Production build | Passed |
| Supplied engine self-checks | All 28 passed with npm access |
| Electron smoke | Real renderer, preload, detection and analysis IPC passed; no captured console errors |
| Rendered UI | Detect → fixture folder selection → analysis → recommendations → plan → install → health report → rollback |
| Stack fixture | Node.js, Next.js, React and Supabase correctly identified with reasons |
| Cross-agent installation | Filesystem, Playwright and Sequential Thinking written into all three seeded agent config formats |
| UI installation timing | 16.0 seconds first completed run; 17.2 seconds on credential-retention reproduction |
| Server discovery | 14 filesystem tools + 24 browser tools + 1 reasoning tool = 39 tools listed |
| Actual tool execution | Read fixture package.json; navigate browser to about:blank; execute sequentialthinking; all succeeded |
| Repeated engine golden path | 3/3 successful runs, 14.2 / 15.6 / 15.2 seconds |
| Existing-config rollback | Byte-identical restoration across all three seeded configs, all three rehearsal rounds and UI runs |
| Edge cases | Confirmed defects listed below |

Timing begins at Install, excludes application startup and uses the warmed npm cache. The first sandboxed build/check attempts hit filesystem/npm cache permissions; the unrestricted build and self-checks passed. Electron initially had slow GPU/cache startup; the repeatable UI harness uses a dedicated profile and software rendering. Folder selection is stubbed to the QA fixture in the automated UI harness; the remaining flow uses the real rendered React controls, preload, IPC, installer and server processes. Native window inspection and opening the folder picker were also exercised.

**Coverage limit:** config compilation into three clients is verified, but actual capability loading inside the three coding-agent applications is not. Tool calls were made directly to MCP servers. GitHub and Supabase authenticated operations were not tested with real credentials. Do not present these results as complete client/authentication certification.

## Confirmed defects in priority order

### 1. Deselected credentials are persisted in the ledger — high priority

**Reproduction:** select GitHub, enter a token on Plan, go Back, deselect GitHub, select credential-free capabilities, install. The fake token appeared in `.agentpack/installs.json`.

**Cause:** `src/App.tsx:63` derives secret keys only from the current selection, then iterates every retained value. At line 68, a previous capability's secret is reclassified as an ordinary input. `electron/core/installer/install.ts:90` persists inputs.

**Change:** build the request from the selected capabilities' declared fields only. Keep secret classification independent of selection and clear unused secret state. Add this exact UI regression test. The UI promise that secrets never enter the ledger is currently false.

### 2. Rollback does not undo newly created config files — high priority

**Reproduction:** seed agent directories with no config files, install Sequential Thinking, then roll back. All three new configs remain and still contain the capability, although rollback has completed.

**Cause:** `electron/core/installer/backup.ts:21` returns immediately for a file that did not previously exist.

**Change:** record file creation and the written content/hash. Remove an AgentPack-created file on rollback only if it has not subsequently changed; otherwise present a conflict. Test both pre-existing and newly created configurations.

### 3. Broken saved configurations receive a healthy result — high priority

**Reproduction:** seed Claude's Sequential Thinking entry with `command: agentpack-nonexistent-command`. Install it again. Result: `already-present`, `reachable: true`, while the invalid command is still on disk.

**Cause:** `electron/core/installer/install.ts:134` checks presence by identifier; line 151 launches the registry command independently of the saved config. An old filesystem scope or disabled server can similarly escape meaningful validation.

**Change:** compare existing command, arguments, enabled state and relevant environment configuration to the intended install. Surface conflicts rather than silently skipping. Validate the resolved per-agent configuration and distinguish “config written”, “server reachable” and “client verified”.

### 4. Rollback overwrites unrelated later edits — high priority

**Reproduction:** install into an existing config, add an unrelated setting, roll back. The later setting disappears.

**Cause:** `backup.ts:22` unconditionally replaces the whole file with the backup.

**Change:** check whether the current file still matches the post-install version. If it differs, offer a targeted undo or conflict resolution. Whole-file restoration is acceptable only when no intervening edit occurred.

### 5. MCP JSON-RPC errors bypass secret redaction — high priority

**Reproduction:** a local mock MCP server returns an error containing a supplied fake token. `probe()` returns the token verbatim in `health.error`; that value is forwarded to progress output and the UI.

**Cause:** `electron/core/installer/health.ts:71` accepts the raw JSON-RPC error; line 111 returns it without redaction. stderr redaction covers a different path.

**Change:** sanitize all error and output paths before crossing the engine/UI boundary, including structured protocol errors. Keep this transport-level regression alongside ordinary string-redaction tests.

### 6. Back from Health report traps the user — medium priority

**Live reproduction:** complete installation, optionally roll back, click Back. Heading becomes “Installing”; the only button is “Show advanced log”. There is no route back to Report, Plan or Recommend.

**Cause:** `src/App.tsx:525` steps backward through the array into the transient install state.

**Change:** use explicit navigation transitions. Back from Report should lead to selections or plan, and an idle install screen should have a recovery action. See the saved screenshot.

### 7. Valid OpenCode JSONC is rejected — medium priority

**Reproduction:** put a comment in the seeded `opencode.jsonc`, then install. The OpenCode result fails with “not plain JSON (comments?)”.

**Cause:** `electron/core/agents/json-config.ts` uses JSON.parse even though the adapter targets a `.jsonc` file. It also only discovers the `.jsonc` filename.

**Change:** support comments/trailing commas with a JSONC-aware parser/editor and discover both supported filenames. This matches [OpenCode's documented config formats](https://opencode.ai/v2/docs/config).

### 8. Apostrophes produce invalid Codex TOML — medium priority

**Reproduction:** compile filesystem access to `C:\Projects\O'Brien App`. Generated output contains `'C:\Projects\O'Brien App'` inside the argument array, prematurely terminating the TOML literal string.

**Cause:** `electron/core/agents/codex.ts:15` wraps every value in unescaped single quotes.

**Change:** use a valid TOML string encoder and parse the resulting document before committing it. Cover apostrophes, Unicode, quotes and line breaks; retain unrelated formatting where possible.

### 9. Export loses required installed input values — medium priority

**Reproduction:** compile a Supabase capability with a known project ref, export with the normal live-config path. Export includes Supabase but no inputs.

**Cause:** `electron/core/capabilities/manifest.ts:60` serializes only explicitly supplied `opts.inputs`; the CLI export passes only the name.

**Change:** recover declared non-secret inputs from the effective config or install record, and round-trip a real installed Supabase entry. The existing test passes an input directly to the builder and misses this user path.

## Additional code-review findings

These were traced in source rather than reproduced through the full user flow:

- CLI import ignores manifest targets and installs into all detected agents (`electron/core/cli.ts:181`). It also lacks a failure exit status based on the report and omits per-agent failures from its summary.
- Async UI actions use `try/finally` without an error state. An IPC or backup failure can leave a user on the Install screen without recovery. Rollback marks the UI successful even if the API returned null.
- Detection checks directories/config files, not executable availability or versions. With no supported agents it continues saying “Looking...” indefinitely and disables scanning.
- Capability selection uses clickable divs without keyboard/checkbox semantics (`src/App.tsx:205`).
- The smoke npm wrapper ignores the child process exit status, and the smoke body does not assert that cards actually rendered. A successful wrapper exit alone is insufficient evidence.
- The registry has no package-version pins. The live Playwright probe resolved an alpha version. Reproducibility needs exact tested versions and a cache-readiness check.
- Build transpilation is not TypeScript type checking; there is no dedicated typecheck script/config or packaged Windows distribution workflow in the repo.

## PRD coverage

| Requirement | Assessment |
|---|---|
| At least two clients, target three | Three adapters; configuration output verified. Actual client loading still needs demonstration. |
| Five integrations | Five registry entries, all MCP. No implemented plugin install path was found. |
| Stack detection and explained recommendations | Implemented and tested. GitHub is inferred from any `.git`; checking remote host would improve accuracy. |
| Individual capabilities and two curated packs | Individual selection works. One pack exists; the UI does not offer pack selection. |
| Universal definition and config compilation | Implemented, with TOML/JSONC limitations above. |
| Safe backup, install and rollback | Clean existing-file flow works; fresh files and intervening edits fail. |
| Credential collection | Masked inputs work, but deselection persistence and error redaction need fixes. |
| Validation | Real server startup and tools/list; direct calls also passed in QA. Saved config/client/auth validation incomplete. |
| Permissions before install | Publisher and commands shown, but no structured permission model or explicit permission summary. |
| Shareable manifest | CLI only; required inputs and target handling need repair. |
| Desktop GUI | Real six-stage flow, with navigation and recovery gaps. |

The GitHub registry entry uses the old reference package while labeling its source “GitHub”. The reference implementation is in the [archived MCP servers repository](https://github.com/modelcontextprotocol/servers-archived); plan migration to [GitHub's maintained official MCP server](https://github.com/github/github-mcp-server), then retest transport, credentials and client support. This migration is a separate compatibility task, not merely changing a package string.

## Changes and additions worth building

1. **Fix the nine reproduced defects first.** Prioritize credentials, rollback and truthful health results before visual polish or new integrations.
2. **Add two real pack choices.** “Local Developer” = Filesystem + Playwright + Sequential Thinking, requiring no credentials. “Full-Stack Builder” = GitHub + Supabase + Playwright. Keep the individual capability toggles. This closes the clearest P0 PRD gap and creates a dependable demo option.
3. **Add agent selection and a config preview.** Let users choose targets, distinguish project/global scope, and show additions, existing entries and conflicts before install. The backend already accepts an agents array.
4. **Make the result prove usefulness.** Offer a narrowly scoped Verify action per capability, show tool names on expansion, and display restart/reload guidance. Prefer “39 tools discovered” for tools/list; reserve “verified” for an actual successful call or client check.
5. **Expose install history, retry and export/import in the GUI.** A persistent list of runs with changes, failures and available undo makes recovery possible after restart. Repair manifest semantics before exposing sharing.
6. **Add explicit permission summaries and tested versions.** Explain filesystem write scope, repository access and database read-only scope. Show publisher/source links and last validation status; avoid inventing a trust score without a defined assessment.

For UI polish, retain the restrained dark theme. Reduce raw command/tool text in the default health table, prevent the “Installed” labels wrapping, improve small muted text contrast, and make statuses distinguish discovery, installation and verification. Put technical detail in expandable rows. Give the empty/no-agent state a clear next action.

For the judge demo: pick the credential-free pack, show the generated configs, install in roughly 15–17 seconds on the warmed machine, run one visible browser action, show a read-only file result, then restore the configs. Finish with the corrected export flow. Add a real client-side demonstration before claiming cross-client readiness.

## Evidence and reproduction

- `.qa/ui-results.json`: actual rendered flow, timings, credential leak, config changes, rollback and navigation failure.
- `.qa/edge-results.json`: targeted engine reproductions and three repeated golden paths.
- `.qa/tool-call-results.json`: successful real tool invocation responses.
- `.qa/ui-health.png` and `.qa/ui-back-trap.png`: actual Electron page captures.
- `.qa/ui-e2e.mjs`, `.qa/edge-review.mjs`, `.qa/tool-calls.mjs`: review harnesses. These record observations; they are not yet a regression suite that fails on every known defect.

Run from the repository root after `npm run build`. The UI harness requires the fixture `.qa/demo-project/package.json`; create it with Next.js, React and Supabase dependency entries if recreating the QA folder. Launch the UI harness through Electron with a Node child-process wrapper, as Electron is a GUI executable on Windows. Run the other two scripts with Node. npm access and local browser availability are needed for real MCP execution. QA runtimes and agent homes are excluded by `.qa/.gitignore`; retained logs contain only test credentials.
