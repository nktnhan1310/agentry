---
name: typescript
description: TypeScript conventions and pitfalls. Use when writing or reviewing .ts/.tsx code, types, or Node tooling in this repo.
---
# TypeScript
Tooling: detect the package manager from the lockfile (pnpm-lock → pnpm, yarn.lock → yarn, bun.lock → bun, else npm). Typecheck with `tsc --noEmit` (or the repo's `typecheck` script) before claiming done.

Types
- No `any`. Use `unknown` + narrowing at boundaries; `// @ts-expect-error <reason>` only with a reason, never `@ts-ignore`.
- Validate external data (HTTP bodies, env, JSON, localStorage) with the repo's schema lib (zod/valibot) and infer types from the schema.
- Prefer unions of string literals or `as const` objects over `enum`.
- Discriminated unions + exhaustive `switch` with `const _x: never = v` in the default branch.
- `satisfies` to check object literals without widening; `readonly` for inputs you don't mutate.
- Non-null `!` only where an invariant is proven nearby; otherwise narrow.
- Explicit return types on exported functions and public module APIs.
- With `noUncheckedIndexedAccess`, handle `undefined` from index access; don't silence it with `!`.
- `import type` for type-only imports.

Async and errors
- No floating promises: `await`, return, or explicitly `void` them. Use `Promise.all` for independent work, `Promise.allSettled` when partial failure is fine.
- `catch (e: unknown)` → narrow with `instanceof Error`. Don't swallow; rethrow with `cause`: `new Error('msg', { cause: e })`.
- Don't mix callbacks and promises; promisify once at the boundary.

Modules and structure
- Follow the repo's module system (ESM `type: module` vs CJS) and path aliases from tsconfig `paths`.
- Avoid new barrel `index.ts` re-exports in app code (cycles, slower builds); import from the source file.
- Keep side effects out of module top level (except entry points).
- Dates: store/transmit ISO-8601 UTC; format at the edge. Money: integer minor units or a decimal lib, never float math.

Node
- `node:` prefix for builtins. Read env once in a typed config module; fail fast on missing vars.
- Streams/large files: stream, don't `readFileSync` big inputs in request paths.

Testing
- Use the repo's runner (vitest/jest). Type-level tests with `expectTypeOf` only where types are the product.
- Test files sit next to the source or in `__tests__`, matching the existing pattern.
