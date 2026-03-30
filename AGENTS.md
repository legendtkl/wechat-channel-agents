# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the service code. Keep new modules close to the existing domain split: `agent/` for Claude/Codex backends, `bridge/` for dispatching and formatting, `wechat/` for API and session handling, `storage/` for persisted state, and `util/` for shared helpers. Entry points live in [`src/index.ts`](/Users/white/workspace/wechat-channel-agents/src/index.ts) and [`src/config.ts`](/Users/white/workspace/wechat-channel-agents/src/config.ts). Tests are co-located with source files as `*.test.ts` or `*.e2e.test.ts`. Docs and assets live under `docs/`; runtime examples live at the repo root in `.env.example` and `config.example.json`.

## Build, Test, and Development Commands
Use Node.js 22+ and `npm` because the repo is locked with `package-lock.json`.

- `npm install`: install dependencies.
- `npm run dev`: start the bot locally through `tsx src/index.ts`.
- `npm run start`: same runtime entry point, useful for parity checks.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm test`: run the Vitest suite, including end-to-end dispatcher tests.
- `npm run build`: compile TypeScript into `dist/`.

## Coding Style & Naming Conventions
Write strict TypeScript with ES modules and explicit `.js` extensions in relative imports. Follow the existing style: 2-space indentation, double quotes, trailing commas where TypeScript emits clean diffs, and small focused modules. Use `camelCase` for functions and variables, `PascalCase` for classes and backend types, and `kebab-case` for filenames such as `context-token.ts` or `send-media.ts`.

## Testing Guidelines
Vitest is the test runner. Add unit tests beside the module you change, and use `*.e2e.test.ts` for full message-flow coverage. Match current naming patterns such as `allowlist.test.ts` and `dispatcher.e2e.test.ts`. There is no published coverage gate, so contributors should add or update tests for every behavior change and run `npm test` plus `npm run typecheck` before opening a PR.

## Commit & Pull Request Guidelines
Recent history uses short imperative subjects, usually with prefixes like `feat:`, `fix:`, `docs:`, and `test:`. Keep commits scoped and descriptive, for example `fix: persist account route tags`. PRs should explain behavior changes, list config or migration impact, include test results, and attach screenshots only when updating docs or bot-facing flows.

## Security & Configuration Tips
Do not commit real credentials in `.env`, `config.json`, or state under `~/.wechat-agents`. Prefer updating the example files when configuration changes. When touching logs or persistence, preserve the project’s existing redaction and session-isolation behavior.
