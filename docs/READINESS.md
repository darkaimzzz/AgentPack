# Hackathon readiness — 12 September 2026 (v2.0.0)

## Assessment: 92 / 100

The credential-free demonstration route is ready: a nested Next.js/Supabase project is detected, a pack is configured across three native agent formats, real MCP servers answer tool discovery, capability management works, and rollback restores the original configs. This is an engineering assessment against the PRD and tested scope, not a claim that every external service or coding-agent session has been certified.

| Area | Score | Evidence / remaining gap |
| --- | ---: | --- |
| Project and agent detection | 15 / 15 | Nested dependencies, workspace patterns, config markers, environment names, generated-directory and symlink exclusions |
| Registry, packs, compatibility and configuration | 20 / 20 | Twelve MCPs (each probed for a real tool list), eighteen plugins, four packs, three config adapters, selected targets, idempotency and explicit conflicts |
| Live validation | 16 / 20 | Real MCP discovery, three actual tool calls and rendered Electron E2E; authenticated GitHub/Supabase and actual client loading remain unverified |
| State safety and recovery | 17 / 20 | Ownership-aware rollback, concurrent-edit rejection, credential filtering, lossless dormancy, atomic persistence; native dormancy may require reactivation before undo, broader crash/concurrency stress testing remains |
| Product usability | 14 / 15 | Working wizard, pack/target choices, truthful health labels, error recovery, Manage and clean documentation; import/export and historical recovery are CLI-first |
| Demo delivery | 10 / 10 | Fresh sandbox, prewarm, repeatable E2E scripts, skippable startup sequence, Windows portable build and five-minute presentation guide |
| **Total** | **92 / 100** | Ready for the tested hackathon demo route |

## Changes delivered

- Fixed Next.js/Supabase detection in nested projects and monorepos. Supabase SSR packages, configuration folders and environment variable names now contribute evidence. DATABASE_URL alone no longer implies PostgreSQL.
- Fixed credential retention after deselection, undeclared input persistence, protocol-error leaks, split-output redaction, and measurement metadata containing launch arguments.
- Replaced unsafe whole-run rollback behavior with before/after ownership comparisons. New configs can be removed; unrelated later settings survive; edited capability entries produce conflicts.
- Prevented rollback from resurrecting a removed Claude dormant entry or deleting a marketplace used by a plugin added later.
- Stopped subsequent writes when another process edits a config during installation. This closes the race where a later snapshot could absorb and then delete a user's edit.
- Preserved full native Claude entries and Codex options across dormancy. Codex/OpenCode use native enable flags. Credential-store failures and logging errors no longer silently lose entries.
- Corrected profile mismatch reporting, unavailable profile members, installed-only cost totals, failed-measurement retry, cache merging and watcher failures.
- Removed Windows shell expansion from npm launch paths. Added bounded output, valid tool-list checks, pagination guards, deadlines and process cleanup fallback.
- Restricted IPC to the main renderer frame, serialized desktop mutations, stopped conflicting watchers, enabled renderer sandboxing, and blocked navigation/new windows.
- Added the Local Developer pack, target selection, fresh demo mode, a portable Windows build and app icon. Simplified promotional documentation and removed duplicated UI-logic tests in favor of real renderer assertions.

## Validation results

| Check | Result |
| --- | --- |
| TypeScript | Pass |
| Focused regression scenarios | 31 runner entries pass, 0 fail: installer, CLM, process, detector and the v1.6.0 review regressions (detector scenarios are grouped inside one entry) |
| Existing selfcheck suite | 75 pass |
| Live engine acceptance | 14 / 14 pass, final rerun included |
| Real Electron UI | 8 / 8 stages pass, repeated runs; no renderer errors |
| Local Developer flow | Nine config entries installed; 39 tools discovered across three MCP servers |
| Actual tools/call | 3 / 3 pass: Filesystem reads a sentinel file; Playwright opens about:blank and closes; Sequential Thinking returns a valid terminal step |
| Runtime dependency audit | Zero known vulnerabilities reported by npm audit --omit=dev |
| Server launch latency | ~3s per MCP server. Health checks ask npm to prefer its cache for the pinned version, so an unreachable or untrusted registry no longer adds ~70s of retries per launch before falling back to that same cache |
| Portable build | Pass; Windows x64, 100,776,716 bytes, unsigned; taskbar icon verified by extracting the embedded 32x32 resource from the executable |
| Packaged launch | Pass: portable launcher returned 0 for the 2.0.0 artifact; packaged app reported ok=true, all three agents, working preload/registry/Manage, no console errors |

Tests use synthetic temporary homes, rather than copying or altering the user's real agent configs. The UI test uses the actual renderer, preload and IPC; only the OS folder picker is replaced with a fixture selection. MCP checks launch real packages. Tests of credential failure use clearly fake fixture tokens.

Evidence is in ignored `.qa/ui-results.json`, `.qa/ui-health.png`, `.qa/tool-call-results.json`, and `.qa/packaged-smoke.txt`. Reproduce with the commands in README.

Artifact: `release/AgentPack-2.0.0-win-x64.exe`

SHA-256: `0532907D8ACE87EB963E615F691AFCEEB4EC020ADBCA2A1772D68ACCEE0B85D6`

## Independent review

An external agent reviewed v1.6.0 with its own fault-injection fixtures and filed seven defects, including three P1s in rollback, credential handling and watcher shutdown. All seven are fixed, with regression tests for each that can be proven headlessly. See [INDEPENDENT-REVIEW.md](INDEPENDENT-REVIEW.md).

## Next steps, in priority order

1. **Before showcasing account integrations:** use dedicated demo GitHub/Supabase credentials and exercise a read-only account operation. Start a real session in each supported coding agent and verify it loads the generated config; separately verify plugin downloads and loading. Current health reports deliberately do not claim these checks passed.
2. **Before broader distribution:** add HTTP transport validation, sign the Windows artifact, and add installer crash/cross-process stress coverage. The GitHub gap is now partly closed — the [maintained official server](https://github.com/github/github-mcp-server) is offered as a plugin for Claude Code and Codex, while the [archived stdio implementation](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github) is retained only because OpenCode has no marketplace; replacing it there still needs HTTP transport or a Docker path.
3. **Highest-value feature additions:** GUI install history with a change preview, manifest import/export from the wizard, per-capability access summaries, and per-agent measurements when configurations differ. These improve the current product more than adding a chat interface or another agent abstraction.

For the current presentation, follow [DEMO.md](DEMO.md), use `--demo`, and select Local Developer. The executable still requires Node/npm on PATH; prewarm on the presentation machine before relying on venue networking.
