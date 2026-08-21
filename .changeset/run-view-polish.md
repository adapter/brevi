---
"@brevi/app": patch
---

Polish the run views: the run detail header shifts clear of the floating sidebar trigger while the sidebar is collapsed, the header's State chip now tracks the Linear issue's live state (the orchestrator's poll refreshes each stored run's ticket state instead of keeping the enqueue-time snapshot forever), and sidebar run cards keep a uniform three-line height by reserving both description clamp lines.
