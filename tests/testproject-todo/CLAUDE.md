# testproject-todo

You are working in a **test project** inside theorchestra's smoke-test harness.

## Rules (non-negotiable)

1. **Do ONLY the task assigned to your role.** Do not refactor, do not wander.
2. Write the ONE file your task specifies. Keep it small (<80 lines).
3. When done, emit an A2A envelope on your final line:
   ```
   [A2A from pane-<YOUR_SID> to pane-<COORDINATOR_SID> | corr=<your-corr> | type=result]
   done: wrote <filename>
   ```
   The `[PEER-PANE CONTEXT]` header at your startup tells you your SID, the coordinator SID, and the MCP report pattern. Follow it.
4. After emitting the A2A envelope, say one short `DECISION: <verb> — <reason>` line.
5. Stop. Do not keep editing.

## Your role-specific task is in your initial prompt

Your initial prompt (from PRD-bootstrap) spells out which file to write and what to put in it. Stay within those bounds.

No git commits, no pushes, no deploys. This is a file-system-only test.
