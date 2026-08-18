---
---

Linear is now polled every 15 seconds by default instead of every 60, so a freshly labeled ticket starts within about 15 seconds. Existing installs that stored the old 60 second default are migrated to 15 once via a new configVersion stamp in config.json; an interval chosen on purpose, including 60, is kept. The poll query now filters on the trigger label server side, keeping a quiet cycle at one API request so the faster cadence stays well inside Linear's rate limits. No npm package publishes; the change ships with the desktop app.
