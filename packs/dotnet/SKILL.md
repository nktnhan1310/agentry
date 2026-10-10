---
name: dotnet
description: .NET / C# / ASP.NET Core / EF Core conventions and pitfalls. Use when writing or reviewing .cs files, csproj, controllers, minimal APIs, MediatR handlers, or EF Core code.
---
# .NET
Check the target framework in the csproj and match the existing architecture (Clean Architecture layers, CQRS/MediatR, vertical slices) before adding code.

C#
- Nullable reference types on: no `!` suppression without a proven invariant; validate at boundaries.
- `record` for DTOs/commands/queries; `sealed` classes by default for implementations; primary constructors where the codebase uses them.
- Async all the way: no `.Result`, `.Wait()`, or `async void` (except event handlers). Pass `CancellationToken` through every async call chain.
- Structured logging: `logger.LogInformation("Order {OrderId} created", id)`. Never string interpolation in log templates; never log secrets/PII.
- Exceptions for exceptional cases; expected failures → Result types or ProblemDetails, following the repo's pattern.
- Time: inject `TimeProvider` (or the repo's clock abstraction) instead of `DateTime.Now`; store UTC (`DateTimeOffset`/`DateTime.UtcNow`).

ASP.NET Core
- DI lifetimes: never inject scoped (DbContext) into singletons; `IServiceScopeFactory` for background services.
- Options pattern (`IOptions<T>` + `ValidateDataAnnotations().ValidateOnStart()`) for config; no `IConfiguration["x"]` scattered in code.
- Validate requests (FluentValidation or the repo's MediatR pipeline behaviour); return `ValidationProblem`/ProblemDetails.
- `[Authorize]`/policies on every endpoint group; `[AllowAnonymous]` deliberately and visibly.
- `IHttpClientFactory` / typed clients; never `new HttpClient()` per request.

MediatR / CQRS
- One handler per command/query; handlers thin, domain logic in the domain/application layer.
- Queries don't mutate; commands return ids/results, not tracked entities.
- Cross-cutting concerns (validation, logging, transactions) in pipeline behaviours, not copied into handlers.

EF Core
- Reads: `AsNoTracking()` + `Select` projection to DTOs; avoid loading full graphs.
- Watch N+1: lazy loading off; `Include` deliberately or project; `AsSplitQuery` for wide includes.
- Raw SQL only via `FromSql`/`FromSqlInterpolated`/`ExecuteSqlInterpolated` (parameterized). Never concatenate.
- Bulk changes: `ExecuteUpdateAsync`/`ExecuteDeleteAsync` instead of load-modify-save loops.
- Migrations: one per logical change; review the generated SQL (`dotnet ef migrations script <from> <to>`); additive first, never drop columns in the same release that stops using them.
- `SaveChangesAsync` once per unit of work; concurrency tokens (`rowversion`) for contested rows.

Testing
- xUnit (or the repo's framework); `WebApplicationFactory<Program>` for API tests; Testcontainers or LocalDB for real DB tests instead of the EF in-memory provider.
- Narrow run: `dotnet test --filter "FullyQualifiedName~<Name>"`. Build warnings in touched files are fixed, not ignored.
