---
"@brevi/app": patch
---

Run detail: the Result tab, its tab bar, and the result summary card are gone entirely (the header's PR chip is how the pull request is reached, and a failed run's error shows as a slim alert above the activity feed), the metadata card (elapsed, attempts, sandbox, worker, run id) and the header's bottom border are removed, pull request links open Mission Control's own PR view first with a small external link to GitHub beside them, and a Codex-style prompt input at the bottom of the Activity pane sends follow-up instructions that queue a "take another look" run carrying the typed text into the agent's prompt. Sidebar: the Live connection badge moves inline with the Runs heading and holds a steady dot instead of pulsing, and the collapse toggle is now one window-fixed control right of the macOS traffic lights, aligned with the page header row, that stays put while the sidebar slides under it.
