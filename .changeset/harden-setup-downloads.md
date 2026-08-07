---
"@brevi/cli": patch
---

Harden brevi setup artifact downloads against SSRF: HTTPS-only host allowlist for firecracker and kernel downloads, with every redirect hop validated.
