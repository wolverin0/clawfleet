# testproject-briefer-probe

A throwaway fixture project used by `scripts/v3-briefer-behavior-gate.ts` to verify the `project-briefer` subagent composes a well-formed briefing.

## Stack
- Python 3.11 (fictional)
- Flask 3.0 (fictional)
- entry point: `app.py` (does not actually exist)
- test command: `pytest -q` (fictional)

## Key files
- `app.py` — HTTP entry point (fictional)
- `schema.sql` — database schema (fictional)
- `tests/test_auth.py` — auth regression tests (fictional)

## Known constraints
- Auth tokens must be rotated every 30 days (fictional, per ingested claim)
- Never log raw request bodies (fictional, per ingested claim)
- Background worker MUST use Redis queue with 10-min TTL (fictional, per ingested claim)
