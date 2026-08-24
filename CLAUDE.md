# Claude Code Guidelines

## Core Principles

- Write the simplest code that solves the problem
- Minimum viable implementation — no speculative features
- No over-engineering, no premature abstraction
- If three lines repeat, that's fine; abstract only when there are 4+ clear reuses

## Response Style

- No preamble, no summaries, no filler text
- Lead with the action or answer
- Skip "Here's what I did" or "Let me explain" unless asked
- No trailing summaries after code changes

## Code Style

- Simple logic over clever logic
- Flat over nested where possible
- No unnecessary comments — code should be self-explanatory
- No docstrings unless the function is a public API boundary
- No type annotations on obviously-typed variables
- Delete dead code; don't comment it out

## What NOT to Do

- Don't add error handling for impossible cases
- Don't add fallbacks, retries, or validation beyond what's needed now
- Don't create helpers or utils for one-off operations
- Don't add feature flags or config options for a single use case
- Don't refactor surrounding code when fixing a bug
- Don't add logging, metrics, or observability unless asked
- Don't suggest follow-up improvements at the end of a response

## File & Edit Discipline

- Edit existing files; don't create new ones unless strictly necessary
- Don't touch files unrelated to the task
- Don't reorganize imports or reformat code you didn't change

## Asking vs. Acting

- If the task is clear, act — don't ask for confirmation
- Ask only when a decision has high blast radius and cannot be undone
- One clarifying question max if needed; never a list of questions
