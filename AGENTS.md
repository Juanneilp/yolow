# Repository Guidelines

## Project Structure & Module Organization

Yolow is a TypeScript agent for monitoring Meteora DLMM positions and executing closes and Jupiter swaps.

- `src/main.ts` initializes the application; `src/agent.ts` coordinates background work.
- Feature directories include `config/`, `execution/`, `market-data/`, `positions/`, `telegram/`, `storage/`, `triggers/`, and `journal/`.
- `test/` contains automated tests; `test/fixtures/` stores sanitized API examples.
- Root documentation includes `README.md`, `ARCHITECTURE.md`, `PRD.md`, and `PRD_SECURITY.md`. Telegram design references are documented in `DESIGN_SYSTEM.md`.

## Build, Test, and Development Commands

Use Node.js 22.21.0 or newer.

- `npm ci`: install dependencies from the lockfile.
- `npm start`: load `.env` and execute TypeScript directly using Node’s experimental type transformation.
- `npm test`: run the test files explicitly listed in `package.json`.
- `node --experimental-transform-types test/execution-security.test.ts`: run execution security tests directly.
- `pm2 start ecosystem.config.cjs`: start the managed application.

After completing changes and passing the relevant tests, always restart Yolow with `pm2 restart yolow` and verify its process status and startup logs. Restart only the Yolow process.

There is no separate build step or configured linting command.

## Coding Style & Naming Conventions

Follow existing TypeScript ES module conventions: two-space indentation, double quotes, semicolons, and `.ts` extensions in local imports. Use `camelCase` for functions and variables, `PascalCase` for classes and types, and descriptive module filenames such as `active-bin.ts`.

Reuse existing helpers, including `safeError`, `redactSecrets`, and `readJsonResponse`. Keep transaction amounts in integer base units. No formatter configuration is provided.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name files `*.test.ts` and describe observable behavior in test names. Add new test files to the explicit `npm test` command.

Use mocked providers and temporary or in-memory SQLite databases. Cover transaction validation, retries, restart recovery, and failure paths when changing execution logic. No numerical coverage threshold is configured.

## Commit & Pull Request Guidelines

Existing commits use concise, imperative English subjects, such as “Fix live close simulation” and “Add Telegram command menu.”

PRs should explain the problem, resulting behavior, test results, and configuration or migration effects. Reference relevant issues or security requirement IDs. Include example messages for Telegram presentation changes.

## Security & Configuration Tips

Keep credentials in `.env` and local settings in ignored `config.json`. Store signing keypairs outside the repository with permission `600`. Never commit secrets, databases, exports, or backups.

Develop in dry-run mode and check the effective mode through `/status`; SQLite persists mode across restarts. Preserve signer validation, simulation, and safeguards against duplicate transactions.
