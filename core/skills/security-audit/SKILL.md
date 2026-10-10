---
name: security-audit
description: Security audit of changed code or a module (OWASP Top 10, authz, secrets, dependencies). Use for auth, payments, user data, uploads, external input, or before release.
---
# Security audit
Scope: the diff or the module named. Follow untrusted data from entry points (HTTP handlers, server actions, webhooks, queue consumers, uploads, CLI args) to sinks (DB, shell, filesystem, HTML, redirects, outbound HTTP, logs).

1. **Map** the entry points and trust boundaries touched (≤5 lines, for yourself).
2. **Walk** only the relevant sections of `references/checklist.md`.
3. **Secrets:** `git diff | grep -nEi "(api[_-]?key|secret|token|passw|BEGIN .*PRIVATE KEY|service_role)"`. Check new config, fixtures, and log statements. Report locations, never values.
4. **Dependencies** (only if manifests changed): `pnpm audit --prod` / `npm audit --omit=dev` / `dotnet list package --vulnerable --include-transitive` / `pip-audit`.

Report (≤30 lines), most severe first:
`[CRITICAL|HIGH|MEDIUM|LOW] path:line — class — exploit scenario (who, how, impact) — fix`
- CRITICAL: unauthenticated remote compromise, data exfiltration, or auth bypass.
- HIGH: authenticated privilege escalation, IDOR on sensitive data, stored XSS, SSRF to internal services.
- MEDIUM: limited-impact injection, missing rate limit on auth, verbose errors leaking internals.
- LOW: hardening (headers, cookie flags) with a plausible path to harm.

Report only issues with a plausible exploit path; mark uncertain ones "(verify)". No generic advice or best-practice lists.
