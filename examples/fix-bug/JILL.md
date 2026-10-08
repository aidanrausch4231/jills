---
name: fix-bug
description: Research a bug, fix it on a Jills branch, then get an independent review.
when: The user reports a bug or failing behaviour and wants it fixed.
keywords: [fix bug, bug, broken, failing, regression]
inputs:
  - name: task
    description: The bug, with how to reproduce it
    required: true
worktree: true
timeout: 90m
steps:
  research:
    jill: research
    inputs:
      task: "Find the cause of this bug: {{inputs.task}}"
  implement:
    agent: harness-implementer
    needs: [research]
    writes: true
    timeout: 45m
    task: |
      Fix this bug: {{inputs.task}}
      Research so far:
      {{steps.research.output}}
      Keep the change small, add or update a test, run the tests. Do not commit; Jills commits for you.
  review:
    agent: harness-reviewer
    needs: [implement]
    timeout: 20m
    task: |
      Review the last commit in this worktree (git show HEAD) against the bug: {{inputs.task}}
      Report defects with path:line. Do not edit files.
---
Runs on its own branch `jills/fix-bug-<run>`; nothing merges into your branch.
