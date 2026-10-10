---
name: react
description: React component, hooks, state, and testing conventions. Use when writing or reviewing React components (.tsx/.jsx), hooks, or UI state logic.
---
# React
Components
- Function components only; keep render pure (no side effects, no mutation of props/state).
- Derive values during render instead of syncing them into state with `useEffect`.
- `useEffect` is only for syncing with external systems (subscriptions, DOM APIs, non-React widgets). Data fetching → the repo's data layer (TanStack Query/SWR/server components), not ad-hoc effects.
- Every effect that subscribes must clean up; the dependency array must be complete (don't disable the lint rule).
- Keys: stable ids from data, never array index for lists that reorder/insert.
- Lift state only as far as needed; prefer composition (`children`, slots) over prop drilling >2 levels or new contexts.
- Context: split by update frequency; memoize the value object if consumers are many.
- `useMemo`/`useCallback`/`memo` only for a measured problem or referential-equality requirements (deps of other hooks, memoized children). If React Compiler is enabled, don't add them.

State
- Server state ≠ client state. Server state in TanStack Query (query keys as arrays, invalidate after mutations); client state in local state or the repo's store (zustand: select narrow slices `useStore(s => s.x)`).
- Forms: the repo's form lib (react-hook-form + zod resolver, if present); otherwise controlled inputs with a single submit handler.
- Put URL-worthy state (filters, tabs, pagination) in the URL.

Accessibility (reviewers flag these)
- Semantic elements: `button` for actions, `a` for navigation; no clickable `div`s.
- Every input has a label; images have meaningful `alt` (or `alt=""` if decorative).
- Focus management for dialogs/menus (use the repo's UI primitives, e.g. Radix/shadcn, which handle it).

Styling
- Follow the repo's system (Tailwind + `cn()` helper, CSS modules, etc.). No inline style objects for static styles.

Testing (Testing Library)
- Query by role/label/text (`getByRole('button', { name: /save/i })`), never by class or test-id unless there's no accessible handle.
- `userEvent` over `fireEvent`; `findBy*` for async UI; assert on visible outcomes, not hook internals.
- Mock the network at the boundary (MSW if present), not the hooks.
