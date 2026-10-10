---
name: supabase
description: Supabase rules (RLS, auth, migrations, keys, storage, edge functions) for JS/TS and Python clients. Use when touching Supabase schema, policies, auth, storage, or supabase client code.
---
# Supabase
Keys and clients
- `anon`/publishable key: safe in browsers only because RLS protects data. `service_role`/secret key: server-only, bypasses RLS; never in client code, `NEXT_PUBLIC_*`, mobile apps, or logs.
- JS server (Next.js): `@supabase/ssr` `createServerClient` with the cookies adapter; browser: `createBrowserClient`. Don't share one client across requests on the server.
- Auth decisions on the server use `supabase.auth.getUser()` (or verified `getClaims()`), never the unverified `getSession()` user.
- Python (`supabase-py`): `create_client(url, key)`. For per-user access from a backend, forward the user's JWT (`client.postgrest.auth(token)`) so RLS applies; use the service key only for trusted admin jobs.

Schema and migrations
- All schema changes via migrations: `supabase migration new <name>` → edit SQL → `supabase db reset` locally → commit. Never click-edit production schema.
- `supabase db diff` only to capture local dashboard changes, then review the SQL.
- Regenerate types after schema changes: `supabase gen types typescript --local > <types path>` (match the repo's path).
- See the `sql` skill for migration safety (expand/contract, concurrent indexes).

Row Level Security (most important)
- `alter table ... enable row level security;` on every table in exposed schemas (`public` and any schema in the API). New table without RLS = data leak.
- One policy per operation and role; `to authenticated` (or `anon`) explicitly. Updates need both `using` and `with check`.
- Wrap auth calls for performance: `using ((select auth.uid()) = user_id)`. Index the columns used in policies.
- Multi-tenant: check membership via a `security definer` helper function with `set search_path = ''` and fully qualified names.
- Views bypass RLS unless `with (security_invoker = true)`. Functions default to invoker; `security definer` only when needed, and they must check `auth.uid()` themselves.
- Test policies: `set local role authenticated; set local request.jwt.claims = '{"sub":"<uuid>"}';` then query, inside a transaction you roll back.

Storage
- Private buckets by default; storage policies on `storage.objects` scoped by `bucket_id` and owner/path prefix (`(storage.foldername(name))[1] = (select auth.uid())::text`).
- Signed URLs with short expiry for private files.

Edge Functions (Deno)
- Verify the JWT (default) unless it's a webhook; webhooks verify the provider signature.
- Secrets via `supabase secrets set`; read with `Deno.env.get`. Create the client per request with the caller's `Authorization` header to keep RLS.

Realtime
- Respects RLS for Postgres changes; enable it only on the tables needed.
