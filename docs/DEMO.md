# Five-minute demo

## Before presenting

1. Install Node.js 22.17+ with npm and run `npm ci`.
2. Run `npm run prewarm`, then `npm run test:tools` on the demo machine. This checks the MCP downloads and an actual browser launch.
3. Run `npm run demo`, or launch `AgentPack-1.1.0-win-x64.exe --demo` from PowerShell. Every launch creates a new sandbox.
4. Keep the tested source checkout and portable executable available. The portable app still needs Node/npm on PATH.

## Presentation

**0:00 — Problem and targets.** Show the three detected sample agents and target checkboxes. Explain that each uses a different native config format.

**0:40 — Detection.** Click Scan demo project. Show Next.js and Supabase, including the nested package path in the evidence. Continue to recommendations.

**1:20 — Review.** Choose Local Developer, then Review plan. Show the three selected servers, commands, and config destinations. This route needs no credentials.

**2:00 — Install.** Click Install selected. Show the progress log and health report. Expect Playwright, Filesystem, and Sequential Thinking to return tools. Tool counts may change if registry package versions change; the tested versions returned 39 in total.

**3:00 — Manage.** Switch to Manage and measure schemas. Toggle Playwright dormant and active. Show that estimated context changes and explain that changes apply to the next client session. Minimal disables all managed capabilities; Frontend requires its listed capabilities to be installed, including Context7, which is outside this demo pack.

**4:00 — Recovery.** Ensure toggled capabilities are active again. Return to Install and click Roll back. Show that the config changes were undone. Back returns to recommendations.

**4:40 — Scope.** Summarize the working route: detect, explain, configure three formats, validate a live server, manage availability, and undo. Authenticated GitHub/Supabase actions and actual client plugin loading require separate account/client testing.

## If something fails

- **Runtime missing:** install Node/npm, then restart AgentPack so it inherits PATH.
- **Download or startup timeout:** rerun prewarm on a working connection. Use the displayed error; do not describe a failed server as installed and verified.
- **Config conflict:** inspect the named config. AgentPack keeps the existing entry and will not overwrite a different command, scope, or credential.
- **Rollback conflict after dormancy:** reactivate the affected capability in Manage, then retry rollback. Later edits to the same entry need manual review.
- **Start again:** close the demo window and relaunch with `--demo`; a new sandbox is created.

Normal mode uses real user configs. Keep `--demo` on the presentation shortcut or command.
