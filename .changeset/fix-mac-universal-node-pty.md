---
"@brevi/desktop": patch
---

Fix the macOS universal build by covering @lydell/node-pty platform binaries with x64ArchFiles. Bun installs both darwin platform packages, so the x64 and arm64 legs carried identical prebuilds and @electron/universal refused to merge them.
