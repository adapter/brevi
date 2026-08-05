---
"@brevi/cli": minor
---

Mission Control quality-of-life redesign: every run now has its own URL (`/runs/<id>`) so run views can be shared by copying the address bar, all queued and finished runs live in the sidebar (the runs table is gone), and demo evidence stays with the local run's artifacts — nothing under `.brevi/` is committed to the branch or embedded in the pull request anymore. Tickets now opt in via the `brevi` label only; the `@brevi` title/description tag (`trigger.tag`) is gone. PR descriptions default to a new concise style, configurable via `github.prDescription` (`"concise"` | `"detailed"`).
