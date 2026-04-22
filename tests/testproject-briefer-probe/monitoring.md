---
project: testproject-briefer-probe
stack: python/flask
entry: app.py
health: curl http://localhost:5000/health
---

# Monitoring — testproject-briefer-probe

## Signals

- name: auth_token_expiring
  trigger_pattern: "token.*expir(ing|ed)"
  action_level: fix_and_pr
  cooldown: 30m
  status: active

- name: redis_worker_dead
  trigger_pattern: "redis.*refused|worker.*timeout"
  action_level: restart
  cooldown: 5m
  status: resolved

## Active issues

- [AUTH-001] Token rotation job missed 2026-04-20 slot (action_level=fix_and_pr)
