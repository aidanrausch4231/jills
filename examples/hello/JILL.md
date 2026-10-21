---
name: hello
description: Write a hello file in a fresh worktree; the smoke test for Jills.
when: The user asks to say hello, greet someone, or test that Jills works.
inputs:
  - name: who
    description: Who to greet
    default: world
worktree: true
timeout: 2m
steps:
  greet:
    run: echo hello {{inputs.who}} > hello.txt
    writes: true
  count:
    run: echo copy {{copy}} sees "$(cat hello.txt)"
    copies: 2
    needs: [greet]
  sign:
    run: echo "signed by jills run $JILLS_RUN_ID" >> hello.txt
    needs: [count]
    writes: true
    timeout: 30s
  check:
    run: grep -q "signed by jills run" hello.txt
    needs: [sign]
---
Plain `run:` commands only, so it needs no agent CLI or network. Tests and the
end-to-end check use it.
