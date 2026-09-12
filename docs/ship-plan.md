# Hackathon release plan

Goal: ship a repeatable Windows demo with truthful detection, safe configuration changes, a usable install/manage UI, and a tested portable build.

The current working tree includes user changes. Preserve and improve those changes in place; do not reset, restore deleted spikes, or commit unrelated work. The PRD and QA review provide scope; this request authorizes implementing the fixes without another approval round.

1. Detection: reproduce nested Next.js/Supabase detection failures, handle supported workspace layouts and marker files with evidence, add regression coverage.
2. Config engine: audit and fix ownership-aware rollback, secrets, request validation, persistence, process lifecycle, manifest round trips, and adapter compatibility. Use deterministic regression tests plus real MCP checks.
3. Manage: review capability dormancy, profiles, cost measurement and file triggers; fix data loss, misleading state and race conditions.
4. UI: review current screens, fix navigation and error recovery, add two packs and target selection, remove promotional copy and redundant markup. Keep implementation details in expandable logs.
5. Ship: validate type checking, engine regression tests, full rendered UI and actual MCP calls, repeated rehearsal and portable packaging. Simplify outdated docs/tests and write a concise launch guide and scored completion report.

Review ownership: detection specialist owns detection/project.ts and detection tests. Root owns engine and integration. Independent reviewer inspects CLM without edits initially. Shared types/API changes are coordinated by root.

Success gates: all deterministic checks pass; three credential-free MCPs work across seeded configs; rollback preserves unrelated state; UI can recover from failures; management state transitions and triggers are verified; portable app launches. Authenticated service calls and OS signing must be explicitly distinguished from locally tested capability.

Progress: implementation and source validation complete. Detection, installer, CLM, UI, actual tool calls and portable packaging pass. Final delivery evidence and outstanding account/client checks are recorded in READINESS.md.
