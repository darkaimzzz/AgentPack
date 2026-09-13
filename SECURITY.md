# Security Policy

## Reporting a vulnerability

Please **do not open a public issue.**

Use GitHub's private vulnerability reporting: go to the [Security tab](https://github.com/darkaimzzz/AgentPack/security) → **Report a vulnerability**. That creates a private thread visible only to maintainers.

Include what you did, what happened, and what you expected. A reproduction against a sandbox (`AGENTPACK_HOME` or `--demo`) is ideal — please don't send us anything from a config containing your real credentials.

Expect an acknowledgement within a week. If a fix is warranted it ships in the next release, with credit unless you'd rather not have it.

## Supported versions

The latest release only. This is a small project; backporting to older tags is not realistic.

## What AgentPack touches

Worth knowing before you assess risk:

- It **writes to files your coding agents execute from** — `~/.claude.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json*`. An MCP server entry is a command line the agent will run.
- It **launches processes** — `npx`, and whatever a capability's `install.command` names, to probe `tools/list`.
- It **handles API credentials** — collected from the user, written into agent config env blocks, and (for Claude Code, which has no native disable flag) stashed locally while a capability is dormant.
- It **reads project directories** during a scan.

Everything privileged happens in the Electron main process. The renderer runs with `contextIsolation` on and `sandbox: true`, executes no shell commands, and reaches main only through explicit IPC channels that verify the sender is the owning window's main frame.

## Credential handling — what is and isn't true

Credentials are **excluded from**: progress logs, the install ledger, exported pack manifests, measurement metadata, MCP protocol errors, and stderr tails surfaced in the UI.

Credentials are **present in**: the agent config files themselves (that is where the agent needs them), the config backups under `~/.agentpack`, and the dormant entry store. These have the same exposure as the agent config they came from — for Claude Code, that was already plaintext in `~/.claude.json`. Keep them private; they are not additionally encrypted, and this project does not claim to be a secret manager.

## The registry is a trust boundary

`registry/` is curated and allow-listed. Every entry names a publisher and pins an exact version. There is no open marketplace and no runtime fetch of capability definitions — adding one requires a reviewed pull request.

Treat a **pack manifest you did not write** as untrusted input. `npm run cli -- import` honours the manifest's declared targets and credential requirements; inspect it before importing.

## Known limitations

Stated rather than hidden:

- Release artifacts are **unsigned**. Verify the SHA-256 published with each release.
- AgentPack cannot observe whether a coding agent actually loaded a config it wrote.
- A green tool list proves the server starts and responds. It does **not** prove a credential is valid or scoped correctly.
- Plugin status is *Configured*, never *Verified* — a plugin loads inside the agent, out of reach.

## Out of scope

- Vulnerabilities in the third-party MCP servers and plugins the registry points at. Report those upstream; tell us too if the registry should stop listing one.
- Anything requiring an attacker who already has write access to the user's home directory or the ability to run code as them. At that point the agent configs are theirs regardless of AgentPack.
- Running AgentPack without `--demo` and having it modify your real config. That is the documented behaviour.
