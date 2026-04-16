---
prd: true
name: "Example Test Agency"
roles:
  - persona: reviewer
    permission_mode: plan
    worktree: false
    task: "Review the CLAUDE.md and docs/ for accuracy."
  - persona: tester
    permission_mode: plan
    worktree: false
    task: "Analyze test/dashboard-smoke.test.cjs and suggest improvements."
scope: docs/
deadline: 2026-12-31
---

## Description

Test PRD for verifying Agency Mode bootstrap. Both agents are read-only
(plan mode) so they cannot modify anything.
