---
name: fix-bug
description: Research a bug, fix it on a Jills branch, then get an independent review.
when: The user reports a bug or failing behaviour and wants it fixed.
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
      This is round {{round}}. Output of the last failed test or review (empty in round 1):
      {{feedback}}
      Keep the change small, add or update a test, run the tests. Do not commit; Jills commits for you.
  test:
    run: npm test
    needs: [implement]
    timeout: 15m
    on_fail: { back_to: implement, max_rounds: 3 }
  review:
    agent: harness-reviewer
    needs: [test]
    verdict: true
    timeout: 20m
    on_fail: { back_to: implement, max_rounds: 3 }
    task: |
      Review the last commit in this worktree (git show HEAD) against the bug: {{inputs.task}}
      Report defects with path:line. Do not edit files.
      End with VERDICT: clean or VERDICT: <problem>.
---
Runs on its own branch `jills/fix-bug-<run>`; nothing merges into your branch. The `test` step runs
`npm test` (change it to your repo's test command); a failing test or a review that does not end
`VERDICT: clean` sends the work back to `implement` (at most 3 rounds).
