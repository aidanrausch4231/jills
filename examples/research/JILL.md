---
name: research
description: Three read-only explorers look at a question in parallel, then a researcher writes one cited answer.
when: The user asks how something works in the codebase, where a flow lives, or wants a researched answer before changing code.
inputs:
  - name: task
    description: The question to research
    required: true
worktree: true
timeout: 30m
steps:
  explore:
    agent: harness-explorer
    copies: 3
    timeout: 15m
    task: |
      Question: {{inputs.task}}
      You are explorer {{copy}} of 3. Explorer 1: trace the main code path.
      Explorer 2: find callers, config and tests. Explorer 3: look for edge cases and
      past changes (git log). Return exact path:line evidence only.
  write:
    agent: harness-researcher
    needs: [explore]
    timeout: 10m
    task: |
      Question: {{inputs.task}}
      Merge these explorer reports into one short, cited answer (path:line).
      Say what is unknown.

      {{steps.explore.output}}
---
Read-only: no step writes, so the worktree only gives the agents a stable copy.
