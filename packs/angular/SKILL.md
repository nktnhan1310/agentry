---
name: angular
description: Angular component, RxJS, DI, forms, routing, and testing conventions. Use when writing or reviewing Angular components, services, templates, or specs (*.component.ts, *.html, *.spec.ts).
---
# Angular
Read the `@angular/core` major in package.json before using an API. Signals, `takeUntilDestroyed` and the `@if`/`@for` control flow need v16–17+; newer APIs (zoneless change detection, resource APIs) only exist in recent majors, so check the docs for the installed version.

Composition
- Match the repo's model: NgModule-based or standalone. New code follows the module it lives in; never leave a feature half-migrated.
- `ChangeDetectionStrategy.OnPush` for new components. Don't retrofit existing ones as a drive-by.
- Templates stay declarative: no method calls that compute in bindings (use a pipe, a `computed()` signal, or a precomputed field).
- Lists: `@for (x of xs; track x.id)` or `trackBy` with `*ngFor`. Leave working `*ngIf`/`*ngFor` alone unless the task is the migration.
- One DI style per class: constructor injection or `inject()`, matching the surrounding code.

RxJS (the usual leak/bug surface)
- Anything that outlives a tick (route params, `valueChanges`, Subjects, `interval`, store selects) must be torn down: `async` pipe in the template, or `takeUntilDestroyed()` / the repo's destroy pattern in TS. One-shot `HttpClient` calls complete on their own.
- No nested `subscribe`. Pick the flattening operator on purpose: `switchMap` (cancel previous: search, route), `concatMap` (keep order: saves), `exhaustMap` (ignore while busy: submit), `mergeMap` (parallel).
- `catchError` inside the inner stream so one failure doesn't kill the outer one. Share HTTP results with `shareReplay({ bufferSize: 1, refCount: true })`.
- Don't rewrite existing RxJS state into signals unless the task says so.

Types & HTTP
- No new `any`: give every HTTP response an interface. Typed reactive forms (`FormGroup<...>`, `nonNullable`).
- Interceptors own auth headers, error mapping and loading state; components don't repeat them.
- Environment values come from the repo's environment/config mechanism, never hard-coded URLs.

Forms & routing
- Reactive forms for anything non-trivial; don't mix template-driven and reactive in one form. Validators on the control, messages in the template.
- Lazy-load feature routes (`loadChildren` / `loadComponent`). Guards and resolvers follow the repo's style (class or functional).

Security
- Angular sanitizes `[innerHTML]`; never call `bypassSecurityTrust*` with user-controlled input.
- Authorization is enforced by the API. UI guards only hide navigation.

Testing
- Find the runner first (`angular.json` test builder, `karma.conf.js`, or Jest config) and run narrow: `ng test --watch=false` plus `--include` for one spec when supported.
- `HttpTestingController` for HTTP, component harnesses where the UI library ships them, `fakeAsync`/`tick` for timers.
- Query the DOM by role/text where possible; assert visible outcomes, not private fields.
