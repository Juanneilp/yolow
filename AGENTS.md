# Repository Guidelines

## Project Structure & Module Organization

Yolow is a TypeScript Meteora DLMM monitor with dry-run SPOT automation and validated close/swap execution.

- `src/main.ts` starts the application; `src/agent.ts` coordinates background jobs.
- Features live in `automation/`, `config/`, `execution/`, `market-data/`, `positions/`, `telegram/`, `storage/`, and `journal/` under `src/`. Indicator and legacy OOR engines are retired; current bin-distance OOR rules live in `automation/`.
- `test/` contains tests; `test/fixtures/` holds sanitized API examples.
- Read `README.md`, `ARCHITECTURE.md`, `PRD.md`, `PRD_SECURITY.md`, and Telegram's `DESIGN_SYSTEM.md` for context.

## Build, Test, and Development Commands

Use **Node.js 22.x ≥22.23.4**; `.nvmrc` pins the verified version. Other majors are unsupported. For the private runtime, prefix commands with `PATH="$PWD/.runtime/node/bin:$PATH"`.

- `npm ci`: install the lockfile's dependencies.
- `npm start`: load `.env` and run TypeScript with experimental type transformation.
- `npm test`: run the test files explicitly listed in `package.json`.
- `node --experimental-transform-types test/execution-security.test.ts`: run execution security tests.
- `npm audit --omit=dev`: check current dependency advisories.
- `pm2 start ecosystem.config.cjs --only yolow`: start Yolow.

There is no separate build or lint command. After tested changes, always run `pm2 restart yolow`; verify the actual interpreter, DRY-RUN status and Telegram polling. Apply interpreter changes through the ecosystem configuration with `--only yolow`. Restart only Yolow.

## Coding Style & Naming Conventions

Use two-space indentation, double quotes, semicolons, ES modules and `.ts` local imports. Use `camelCase` functions/variables, `PascalCase` types/classes, and descriptive filenames such as `active-bin.ts`. Reuse `safeError`, `redactSecrets`, and `readJsonResponse`. Keep transaction amounts in integer base units. No formatter is configured.

## Testing Guidelines

Use `node:test` and `node:assert/strict`; name files `*.test.ts` and register new files in `npm test`. Use mocked providers and temporary/in-memory SQLite. Cover transaction validation, failures, retries, restart recovery and dry-run isolation. Never test with production funds. No coverage threshold is configured.

## Commit & Pull Request Guidelines

Use concise imperative English subjects, such as “Fix live close simulation.” PRs explain the problem, resulting behavior, validation and configuration/migration effects. Reference relevant issues/security IDs and show example Telegram messages for presentation changes.

## Security & Configuration Tips

Keep credentials in `.env`, settings in ignored `config.json`, and permission-600 keypairs outside the repository. Never commit secrets, databases, exports or backups.

Use the official HTTPS npm registry and lockfile integrity checks. Pin compatible patches; never run `npm audit fix --force`. Record residual advisories in `PRD_SECURITY.md`.

Check `/status` and `/auto`; SQLite persists mode. Preserve signer validation, simulation, duplicate-send protection and separate paper accounting. Automation must never sign or broadcast.
