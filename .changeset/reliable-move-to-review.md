---
"@brevi/cli": patch
---

Moving a ticket to In Review after a successful run now sticks: Linear's GitHub integration reacts to the just-opened PR and knocks the issue back to In Progress moments after brevi sets In Review, so brevi now re-checks the state 5s and 20s later and re-asserts In Review when that automation reverted it. Only reverts to another started-type state are re-asserted; a concurrent move to Done, Canceled, or any other state is left alone. Linear state updates also retry once on failure and log a run event on success (`moved PD-x to review`) or failure (`failed to move PD-x to review: <reason>`) instead of failing silently, and cancelling a run during the re-check window aborts the wait immediately and records the run as cancelled.
