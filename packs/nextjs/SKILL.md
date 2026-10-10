---
name: nextjs
description: Next.js App Router rules (server/client components, server actions, caching, routing). Use when editing app/ routes, layouts, server actions, route handlers, or next.config.
---
# Next.js (App Router)
Check the installed major version in package.json first; APIs below are for 15+.

Server vs client
- Components are Server Components by default. Add `"use client"` only at the leaf that needs state, effects, or browser APIs; keep layouts and pages server-side.
- Never import server-only modules (DB, secrets, `fs`) into client components. Mark such modules with `import 'server-only'`.
- Pass only serializable props from server to client components.
- `NEXT_PUBLIC_*` env vars ship to the browser. Secrets must not use that prefix.

Data and mutations
- Fetch data in Server Components or a server data-access layer, not in client effects.
- Server Actions (`"use server"`) are public POST endpoints: validate input (zod) and check authn/authz inside every action. Return typed results; don't throw raw errors to the client.
- After mutations call `revalidatePath`/`revalidateTag` (or `router.refresh()` from the client) so the UI updates.
- Route handlers live in `app/**/route.ts`; use them for webhooks and external clients, actions for app forms.

Caching (15+)
- `fetch` is not cached by default; opt in with `cache: 'force-cache'` or `next: { revalidate, tags }`.
- `cookies()`, `headers()`, `searchParams` make a route dynamic; keep them out of shared layouts.
- `params` and `searchParams` are Promises in pages/layouts/route handlers: `const { id } = await params`.

Routing and UI
- Colocate `loading.tsx`, `error.tsx` (must be a client component), and `not-found.tsx` per segment as needed.
- `next/link` for navigation, `next/image` with width/height or `fill` + `sizes`, `next/font` for fonts.
- Metadata via `export const metadata` / `generateMetadata`, not manual `<head>` tags.
- Middleware runs on the edge runtime: no Node APIs, keep it light, and don't rely on it as the only auth check.

Common review flags
- `"use client"` on a page/layout "to make it work" → move the interactive part into a child.
- Waterfalls: sequential awaits for independent data → `Promise.all` or parallel components with Suspense.
- Large client bundles: heavy libs imported in client components; use dynamic `import()` or keep them server-side.
- Hydration mismatches: `Date.now()`, `Math.random()`, or `window` checks during render.
