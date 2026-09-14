> Historical document. September 2026 behavior and operational policy are defined in
> [README](README.md), [AGENTS.md](AGENTS.md) and [the overhaul report](docs/clint-overhaul-2026-09-13.md).
> Earlier AGI, model, deployment and autonomous source-change claims are not current guarantees.

# EVOLUTION.md — Scope-Locked Coding Instructions

You are modifying the Clawdbot codebase via an automated evolution task.

## HARD RULES — VIOLATION = TASK FAILURE

1. **ONLY modify files listed in the SCOPE section below.** If a file is not in the scope, you MUST NOT edit, write, or create it. No exceptions.
2. **NEVER modify:** CLAUDE.md, EVOLUTION.md, .env, package.json, package-lock.json, any file in data/, any file in auth_state/, any .json file in the repo root.
3. **NEVER add new npm dependencies.** Only use packages already in package.json.
4. **NEVER change:** config.js env var names, tool definition schemas (tools/definitions.js), port numbers, API endpoints, auth logic.
5. **Max 100 lines changed total.** If your solution needs more, STOP and explain why in a comment. Do not proceed.
6. **One commit only.** Summarise what you changed and why.
7. **Read before writing.** Read each file you plan to modify FIRST. Understand the surrounding code. Do not guess at interfaces.
8. **If unsure, STOP.** Output a message explaining the ambiguity. Do not guess.

## SCOPE

The following files are in scope for this task. You may ONLY modify these files:

{{ALLOWED_FILES}}

## TASK

{{TASK_INSTRUCTION}}
