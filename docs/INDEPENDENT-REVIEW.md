# Independent review: v1.6.0

An external agent reviewed the codebase at tag `v1.6.0`
(`760c702ca236b3597506a2fcd5f89e653791bb19`) with no access to the decisions
behind it, ran its own fault-injection fixtures, and filed seven defects.

**All seven are fixed.** Each was reproduced with the reviewer's own fixture
before being touched, and every defect that can be proven without a desktop
window has a regression test in `electron/core/review-v160.test.ts`.

| # | Severity | Defect | Resolution |
| --- | --- | --- | --- |
| 1 | P1 | A failed post-write snapshot defeated rollback; dormancy dropped its recovery entry | The post-image hash is taken before the copy and the copy may fail; a `written` flag separates "nothing to undo" from "cannot attribute"; the dormant stash is dropped only once the live entry is back |
| 2 | P1 | Malformed existing TOML exposed pre-existing credentials in errors | Every parse error goes through one helper that keeps the diagnostic and drops the source excerpt |
| 3 | P1 | An errored watcher stayed open and activated capabilities after Stop | The watcher closes itself before reporting; the IPC layer stops through the handle instead of discarding it |
| 4 | P2 | Duplicate JSONC sections produced Installed/Verified with no readable entry | Duplicated top-level keys are refused as ambiguous, and install reads every entry back before claiming success |
| 5 | P2 | Validly quoted marketplace tables blocked Codex plugin installation | The document is parsed rather than matched with a bare-header regex |
| 6 | P2 | The rehearsal falsely passed a partial cross-agent conflict | Conflicts count as problems, and the clean-baseline guard reports partial dirtiness |
| 7 | P3 | Rollback removed comments added after installation | Wholesale byte restore is reserved for formats without comments; TOML and JSONC take a surgical path, and table removal no longer swallows trailing comments |

One reported behaviour was deliberately left alone: a multiline TOML string
containing a table-looking line causes deactivation to fail, but the original
bytes are preserved. The reviewer did not file it as a defect for that reason,
and neither do we.

The reviewer's own words follow, unedited.

---

# AgentPack v1.6.0: independent review and live test results

Reviewed 12 September 2026, commit `760c702ca236b3597506a2fcd5f89e653791bb19` (tag v1.6.0). Review only: no implementation files changed. Reproduction fixtures use isolated homes, synthetic credentials and, where stated, fault injection.

## 1. Verdict

The controlled, credential-free demo path passes. I would rehearse that path, but would not call this release production-ready until the three P1 failures below are addressed. Passing normal-path tests currently conceals failures in rollback, secret handling and watcher shutdown.

This review does not establish authenticated GitHub/Supabase operation, actual coding-agent session integration, HTTP transport health, or the packaged executable's distribution behavior. Those previously acknowledged coverage gaps are not listed as new bugs.

## 2. Confirmed defects

### P1: A failed post-write snapshot defeats rollback; dormancy can also drop its recovery entry

Locations: `electron/core/installer/install.ts:182`, `electron/core/installer/backup.ts:67`, `electron/core/installer/install.ts:262`, `electron/core/clm/state.ts:208`.

Reproduce: `node .qa/review-v160/repros.mjs`, cases `snapshot_failure_install` and `snapshot_failure_dormancy`.

Install case: start with empty Claude settings, install Superpowers, and make the expected `.after` snapshot destination a directory immediately before configure. This causes a real filesystem copy failure after the config write. Then invoke rollback.

Actual: install reports `failed`; the plugin is present both before and after rollback; rollback returns `restored: [], removed: [], merged: []` and marks the ledger undone. The mutation survives a purported successful undo.

Dormancy case: seed an active Claude filesystem entry, inject an ENOSPC exception specifically into post-write snapshot copying, then deactivate. Actual: `success:false`, `liveEntry:false`, `dormantEntry:false`, `backupRetained:true`. The catch path drops the dormant entry after a restore that did nothing. The original backup remains available for manual recovery; this is not irreversible data loss.

Expected: a mutation without a completed post-image must remain recoverable and must not be marked undone unless restoration is established. Failed deactivation must retain recovery state.

### P1: Malformed existing TOML exposes pre-existing credentials in errors

Locations: `electron/core/agents/codex.ts:173` (also the MCP write path at line 219), `electron/core/installer/install.ts:187`.

Reproduce: `node .qa/review-v160/extra.mjs`, case `existing_secret_in_parse_error`. Seed Codex config with `[mcp_servers.old.env]` and an unterminated `TOKEN = "FAKE_PREEXISTING_SECRET`, then install Superpowers without passing new secrets.

Actual: `leakedInReport:true`, `leakedInProgress:true`. The error includes the original line `TOKEN = "FAKE_PREEXISTING_SECRET` because the TOML parser embeds source context. Redaction only knows secrets provided in the current request.

Expected: display a safe parse diagnostic without copying credential-bearing source lines into reports/progress. Only a synthetic sentinel was used in this test.

### P1: Watcher survives its reported failure and still activates capabilities after Stop

Locations: `electron/core/clm/trigger.ts:113`, `electron/ipc/handlers.ts:79`.

Reproduce after build: `node_modules/.bin/electron.cmd .qa/review-v160/watcher.mjs --demo`. This uses a real Electron window, preload and IPC. Start watching with dormant Codex Playwright; corrupt the dormant store and touch a test file; repair the store; call Stop; then touch another test file.

Actual: status reports `Automatic activation failed. Check agent configuration and the dormant store.`; Stop and subsequent status return null; nevertheless `activatedAfterStop:true`. The callback exception leaves the underlying watcher open, while the IPC error callback discards the only handle used to stop it.

Expected: an errored watcher must be closed or remain stoppable. No activation/config mutation should occur after Stop.

### P2: Duplicate JSONC sections produce Installed/Verified with no readable installed entry

Locations: `electron/core/agents/json-config.ts:53`, `electron/core/installer/install.ts:182`.

Reproduce: `node .qa/review-v160/extra.mjs`, case `duplicate_sections`. Seed OpenCode with `{"mcp":{},"mcp":{}}`; install Memory using a local fixture MCP that answers initialize/tools-list.

Actual: `status:"installed"`, `health:"verified"`, `liveEntry:null`. The edit inserts Memory in the first `mcp` object, while the reader resolves the last empty object. The health check proves the fixture process works, but not that the saved effective configuration contains it.

Expected: reject duplicate sections as ambiguous or validate the effective saved entry before claiming success. This test uses a synthetic server to isolate config handling, not to claim real Memory-server validation.

### P2: Valid quoted marketplace tables prevent Codex plugin installation

Location: `electron/core/agents/codex.ts:158`.

Reproduce: `node .qa/review-v160/repros.mjs`, case `quoted_marketplace`. Seed a valid `[marketplaces."claude-plugins-official"]` table with the official Git source, then install Superpowers.

Actual: `validBefore:true`, install fails with `trying to redefine an already defined table or value`. The bare-header regex misses the quoted key and appends a second equivalent table. The invalid write is safely refused; the defect is rejection of a supported valid input, not file corruption.

Expected: recognize the existing marketplace regardless of legal TOML key quoting.

### P2: Rehearsal falsely passes a partial cross-agent conflict

Locations: `electron/core/rehearse.ts:66`, `electron/core/rehearse.ts:80`.

Reproduce: `node .qa/review-v160/rehearse.mjs`. The wrapper supplies a synthetic source home: Claude already has filesystem scoped to a different project; Codex/OpenCode start empty. It runs the real rehearsal implementation once.

Actual output: `✓ run 1 15736ms`, `4 capabilities · 3 configs touched · restored clean`, then `1/1 runs clean`. The baseline guard requires presence in every agent, and the result loop only counts `failed`, ignoring `conflict`. Installs on other targets allow aggregate health and write checks to pass.

Expected: the rehearsal must report the unresolved capability/agent conflict. This is a false-positive success, beyond the already known inconvenience of running rehearsal against a dirty home.

### P3: Rollback removes comments added after installation

Location: `electron/core/installer/backup.ts:84`.

Reproduce: `node .qa/review-v160/repros.mjs`, case `rollback_comments`. Install a Codex plugin; append `# USER COMMENT ADDED AFTER INSTALL`; roll back.

Actual: `commentPreserved:false`. Semantic equality with the post-install config triggers full restoration of old bytes, discarding later comments.

Expected: preserve unrelated later annotations, or explicitly disclose that rollback preservation excludes comments. This is low-impact annotation loss, not a changed runtime setting.

## 3. Suspected issues

No additional suspicions are promoted to bugs. A multiline TOML string containing a table-looking line caused deactivation to fail, but recovery preserved the original bytes (`changed:false`); I did not count that as config corruption. Abrupt process termination was not reproduced, so the snapshot findings above are based on observed I/O failures, not a claimed crash test.

## 4. Design observations, separate from bugs

Export flattens capabilities and targets into two lists. Exporting Memory only on Codex and Superpowers only on Claude produces both capabilities plus both targets. This cannot preserve per-agent topology. That may be intentional pack semantics; document it rather than treating it as a proven importer defect.

No defects are filed for the explicitly accepted plugin Configured label, approximate token counts, disclosed plaintext dormant credentials, demo motion behavior, or curated GitHub package choice.

## 5. Verified working

All commands completed successfully on this checkout:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 24 runner entries passed; zero failed (detector scenarios grouped inside one entry) |
| `npm run check` | 75 self-checks passed |
| `npm run e2e` | All 14 stages passed |
| `npm run test:ui` | All eight stages passed through Electron/preload/IPC |
| `npm run test:tools` | Actual filesystem read, Playwright navigation and sequential-thinking calls passed |
| `npm run smoke` | `ok:true`, three agents, three profiles, no console errors |

The engine/UI checks cover detection, recommendations, credential gating, three-agent configuration, real credential-free MCP startup/tool discovery, repeat install, management, profiles, dormancy, file triggers, export and byte-identical normal rollback. Next.js/Supabase detector regression scenarios passed; this does not imply authenticated Supabase MCP validation.

Additional live Electron checks exercised the intro animation, maximize/restore/minimize and minimum 900×640 window size. Intro dismissed; window controls worked; DOM layout checks found no overflow; renderer console errors were empty. A saved screenshot was stale relative to later DOM state and is not used as evidence for the recommendations screen.

Raw new-failure evidence: `repros.json`, `extra.json`, `watcher.json` in this directory. Runnable fixtures: `repros.mjs`, `extra.mjs`, `watcher.mjs`, `rehearse.mjs`, `demo-ui.mjs`. Existing automated checks also rebuilt the application successfully. The unsigned release executable was not rebuilt or certified in this review.

## 6. Highest-value fix before the demo

Make post-write snapshot failure recoverable, and prevent rollback from marking a transaction undone when restoration was skipped. Backup/rollback is a central product promise, and this failure also affects capability deactivation. Then address the credential diagnostic and orphan watcher before presenting the app as safe to use against real agent configs.

No source fixes were made. Final tracked/untracked status remained the pre-existing `?? AGENTS.md`; review artifacts are ignored under `.qa/review-v160/`.
