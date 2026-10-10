# Security checklist (read only the sections relevant to the scope)

## Injection
- SQL: string-built queries; `FromSqlRaw` / `ExecuteSqlRaw` with interpolation; `text()` / `.execute(f"...")`; raw `sql` template misuse; dynamic ORDER BY or column names without an allow-list.
- Command: `exec`, `spawn(shell:true)`, `Process.Start` with user input, `subprocess(..., shell=True)`, `os.system`.
- Path traversal: user input in file paths without normalize + root check (`..`, absolute paths, symlinks), zip-slip on extraction.
- Template/eval: `eval`, `new Function`, `pickle.loads`, `yaml.load` (unsafe), `BinaryFormatter`, `TypeNameHandling.All`.

## XSS / output
- `dangerouslySetInnerHTML`, `innerHTML`, `@Html.Raw`, `| safe`, markdown rendered without sanitizing.
- User-controlled `href`/`src` (`javascript:` URLs); open redirects via `returnUrl`/`next` without an allow-list.

## Authentication
- JWT: signature verified, `alg` pinned (no `none`/HS↔RS confusion), `exp`/`aud`/`iss` checked.
- Sessions: rotated on login, `HttpOnly` + `Secure` + `SameSite` cookies, logout invalidates server-side.
- Passwords: argon2/bcrypt/PBKDF2 only; reset tokens random, single-use, short-lived; constant-time compare.
- Rate limiting / lockout on login, OTP, password reset, and signup.

## Authorization (most common real bug)
- Every new endpoint, server action, RPC, or GraphQL resolver checks *who* and *which resource* (ownership/tenant), not only "is logged in".
- IDOR: IDs from the client used without an ownership filter (`where id = ? and owner_id = current_user`).
- Mass assignment: binding a request body straight to an entity (role, isAdmin, tenantId, price fields).
- Admin-only paths enforced server-side, not only hidden in the UI.

## Supabase / Postgres
- RLS enabled on every table in exposed schemas; a policy exists for each operation used; `USING` and `WITH CHECK` both set for update.
- `service_role` key never in client code, `NEXT_PUBLIC_*`, mobile apps, or logs.
- `security definer` functions set `search_path = ''` and check `auth.uid()` themselves.
- Views use `security_invoker = true` (otherwise they bypass RLS).
- Storage buckets: public flag intended; storage policies restrict by owner/path.
- Server code uses `auth.getUser()` / verified claims for auth decisions, not `getSession()` data.

## Next.js / React
- Server actions are public POST endpoints: validate input (zod) and check authz inside each action.
- Secrets only in server code; check `"use client"` files and `NEXT_PUBLIC_` vars.
- Middleware is not the only auth layer (it can be bypassed); also check in route handlers/actions/data access.

## .NET
- `[Authorize]` on controllers/endpoints or a fallback policy; `[AllowAnonymous]` used deliberately.
- Anti-forgery on cookie-authenticated form posts; CORS not `AllowAnyOrigin` with credentials.
- No `Debug`/Developer exception page in production; ProblemDetails without stack traces.

## SSRF / outbound
- User-supplied URLs fetched server-side: allow-list hosts, block private/link-local ranges (169.254.169.254, 10/8, 127/8), no redirects to internal hosts.
- Webhooks: verify the signature (HMAC) with a constant-time compare, and reject replays (timestamp).

## Uploads
- Size limits, content-type sniffing (not the extension alone), random server-side names, stored outside the web root or in a private bucket, no SVG/HTML served inline from the same origin.

## Data & logging
- PII, tokens, and passwords never logged; errors don't echo internals to clients.
- Crypto: no `Math.random` / `Random` for tokens (use CSPRNG); no ECB, MD5, or SHA1 for security; keys from config/secret store.
- Money/balances: transactions with row locks or atomic updates (no read-modify-write races).

## Config
- Debug flags off in prod; security headers (CSP, HSTS, X-Content-Type-Options, frame-ancestors).
- Dependency pinning via lockfile; no `postinstall` scripts from untrusted packages added in the diff.
