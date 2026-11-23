# AGENTS.md

Vanr is an open source workspace where people and AI agents work together: chat, wiki, databases, routines and connectors. Bun monorepo: apps in `apps/`, shared packages in `packages/`.

## Verification

Run from the repo root before saying a change is done: `bunx biome ci .`, `bun run typecheck` and `bun test`. CI (`.github/workflows/ci.yml`) also runs the UI gallery build, `bun run build` and the Postgres-backed tests.
