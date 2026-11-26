# AGENTS.md

Vanr is an open source workspace where people and AI agents work together: chat, wiki, databases, routines and connectors. Bun monorepo: apps in `apps/`, shared packages in `packages/`.

## Verification

Run from the repo root before saying a change is done: `bunx biome ci .`, `bun run typecheck` and `bun test` (the root test run leaves `apps/web` out). For the web app, run `bun test` and `bun run build` inside `apps/web`. CI (`.github/workflows/ci.yml`) also runs the UI gallery build (`bun run --cwd packages/ui gallery:build`), the runner's sandbox tests (they need bubblewrap and socat) and the Postgres-backed tests. Those skip unless `VANR_TEST_POSTGRES_URL` points to a throwaway Postgres with pgvector: the tests create databases on that server. The `postgres` job in `ci.yml` lists the files and the env flags of each run.
