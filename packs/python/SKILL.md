---
name: python
description: Python conventions (typing, tooling, FastAPI, async, pytest). Use when writing or reviewing .py files, pyproject/requirements, or Python services and scripts.
---
# Python
Tooling: detect from lockfiles: `uv.lock` → prefix commands with `uv run` (add deps with `uv add`); `poetry.lock` → `poetry run` / `poetry add`; else a venv + pip. Never install globally. Lint/format with ruff (`ruff check --fix`, `ruff format`); typecheck with mypy/pyright if configured.

Code
- Match `requires-python`; use modern syntax (`list[str]`, `X | None`, `match` where clearer).
- Type hints on all public functions; `TypedDict`/`dataclass(slots=True)` for internal records; Pydantic v2 models at I/O boundaries (`model_validate`, `model_dump`; not v1 `parse_obj`/`dict`).
- No mutable default args; no bare `except:`; catch specific exceptions and re-raise with `raise ... from e`.
- `pathlib.Path` over `os.path`; context managers for files, locks, sessions, clients.
- `logging.getLogger(__name__)` with lazy formatting (`log.info("x=%s", x)`); no `print` in library/service code.
- Settings from env via pydantic-settings (or the repo's config module), loaded once and validated at startup.
- Time: timezone-aware UTC (`datetime.now(tz=UTC)`); money: `Decimal`.

Async
- Never block the event loop: use async clients (`httpx.AsyncClient`, async DB drivers); wrap unavoidable sync calls in `await asyncio.to_thread(fn)`.
- Reuse clients (one `AsyncClient` per app lifespan), set timeouts on every network call.
- `asyncio.gather` for independent awaits; `TaskGroup` (3.11+) when failures should cancel siblings.

FastAPI (if present)
- Dependencies (`Depends`) for DB sessions, the current user, and settings; auth checked in a dependency, not inside handlers ad hoc.
- `response_model` / return type annotations for every route; explicit status codes; `HTTPException` only at the API layer.
- Sync `def` routes run in a threadpool; `async def` routes must not call blocking code.
- Lifespan handler for startup/shutdown resources (not deprecated `on_event`).

Testing (pytest)
- Fixtures for setup, `@pytest.mark.parametrize` for cases, `tmp_path`, `monkeypatch` for env.
- Async tests with the plugin the repo uses (pytest-asyncio/anyio). Mock HTTP at the transport (respx/httpx MockTransport).
- Narrow run: `pytest path/test_x.py::test_name -q -x`.
