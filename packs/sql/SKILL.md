---
name: sql
description: SQL query, schema, index, and migration rules for SQL Server and Postgres. Use when writing queries, migrations, schema changes, or reviewing data-access performance.
---
# SQL
Identify the dialect first (SQL Server/T-SQL vs Postgres): `TOP` vs `LIMIT`, `IDENTITY` vs `GENERATED ... AS IDENTITY`, `NVARCHAR` vs `text`, `GETUTCDATE()` vs `now()`, `[x]` vs `"x"` quoting.

Queries
- Always parameterized. Dynamic identifiers (sort column, table) only from an allow-list.
- Explicit column lists; no `SELECT *` in application code.
- Sargable predicates: no functions or implicit casts on indexed columns (`WHERE created_at >= @d`, not `WHERE CAST(created_at AS date) = @d`).
- `NOT IN` with a nullable subquery returns nothing → use `NOT EXISTS`.
- Large pagination: keyset (`WHERE (created_at, id) < (@c, @id) ORDER BY created_at DESC, id DESC`) instead of deep `OFFSET`.
- Upserts: `INSERT ... ON CONFLICT` (Postgres); in SQL Server, avoid `MERGE` races; use `UPDATE` then `INSERT` with proper locking/unique constraints.
- Read the plan for new or changed hot queries: Postgres `EXPLAIN (ANALYZE, BUFFERS)`; SQL Server actual plan + `SET STATISTICS IO ON`.

Schema
- Every table has a primary key; foreign keys with an index on the referencing column.
- Index new filter/join/order columns; composite index order = equality columns first, then range/sort.
- Money: `decimal(19,4)` / `numeric`, never float. Time: UTC (`timestamptz` / `datetime2` + UTC convention or `datetimeoffset`).
- Constraints (NOT NULL, CHECK, UNIQUE) in the DB, not only in app code.

Migrations (zero-downtime by default)
- Expand → migrate → contract: add nullable column/new table → backfill in batches → switch code → enforce NOT NULL/drop old in a later release.
- Postgres: `CREATE INDEX CONCURRENTLY` (outside a transaction) on large tables; adding a column with a constant default is cheap (11+), volatile defaults rewrite the table.
- SQL Server: online index ops need Enterprise edition; large backfills in batches of ~5k with `WAITFOR` pauses if needed.
- Every migration is reviewable as SQL and has a rollback story (down migration or a forward fix).
- Never edit an already-applied migration; add a new one.

Transactions
- Keep them short; no network calls inside. Consistent lock order to avoid deadlocks.
- Read-modify-write on counters/balances → atomic `UPDATE ... SET x = x - @n WHERE x >= @n` or row locks (`SELECT ... FOR UPDATE` / `UPDLOCK`).
