---
name: fix-jill-bug
description: Research a bug, fix it, loop review until clean, then squash-merge the fix into your branch.
when: The user reports a bug, wants it fixed and reviewed, and wants the fix merged into their branch when it is clean.
keywords: [fix and merge, fix it and merge, fix bug and merge]
inputs:
  - name: task
    description: The bug, with how to reproduce it
    required: true
worktree: true
timeout: 3h
steps:
  research:
    jill: research
    inputs:
      task: "Find the cause of this bug: {{inputs.task}}"
  build:
    agent: harness-implementer
    model: anthropic/claude-opus-5-5
    needs: [research]
    writes: true
    timeout: 45m
    task: |
      Fix this bug: {{inputs.task}}
      Research:
      {{steps.research.output}}
      This is round {{round}}. Feedback from the last failed review or merge (empty in round 1). If it
      lists merge conflicts, resolve the conflict markers in those files first:
      {{feedback}}
      Keep the change small, add or update a test, run the tests. Do not commit; Jills commits for you.
  review:
    agent: harness-reviewer
    needs: [build]
    verdict: true
    timeout: 20m
    on_fail: { back_to: build, max_rounds: 3 }
    task: |
      Review the commits Jills made in this run (subjects start with "jills(fix-jill-bug)"; use
      git log and git show) against the bug: {{inputs.task}}
      List defects with path:line. Do not edit files.
      End with exactly one line: "VERDICT: clean" when there is nothing to fix, else "VERDICT: <short list>".
  merge:
    agent: squash-merge
    model: openai-codex/gpt-6-luna
    needs: [review]
    merges: true
    timeout: 15m
    on_fail: { back_to: build, max_rounds: 2 }
    task: |
      Squash-merge this run into the user's branch. Bug fixed: {{inputs.task}}
      Use this commit subject: "Fix: {{inputs.task}}" (shorten it to one line under 72 characters).
---
Runs on its own branch `jills/fix-jill-bug-<run>`. The review loops back to the build step until it
says `VERDICT: clean` (at most 3 rounds). Then the `merge` step (the only step with `merges: true`)
squash-merges the run branch into the branch you started the run from. Jills refuses to merge into a
checkout with uncommitted changes or on another branch, and accepts the merge only if your branch got
exactly one new commit holding the squash of the run branch. A conflict sends the work back to build
with your branch merged into the run branch and the conflicting files named in the feedback.
