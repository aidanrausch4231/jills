---
name: __NAME__
description: One line on what this Jill does.
when: When the user asks to ... (Jev reads this to match chat messages)
inputs:
  - name: task
    description: What to do
    required: true
worktree: true  # strongly recommended: agents work in their own git worktree; false edits your checkout directly
timeout: 30m
steps:
  first:
    run: echo "working on {{inputs.task}}"
  # second:
  #   agent: harness-implementer
  #   task: "{{inputs.task}}"
  #   needs: [first]
  #   writes: true
  # test:                     # checks are explicit steps: test what a writing step changed
  #   run: npm test
  #   needs: [second]
  #   on_fail: { back_to: second, max_rounds: 3 }
---
Notes for people reading this Jill.
