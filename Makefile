.PHONY: install lint lint-fix format format-check typecheck test test-watch test-fast coverage check ci clean integration e2e

install:
	pnpm install

lint:
	pnpm run lint

lint-fix:
	pnpm run lint:fix

format:
	pnpm run format

format-check:
	pnpm run format:check

typecheck:
	pnpm run typecheck

test:
	pnpm run test

test-watch:
	pnpm run test:watch

test-fast: test

coverage:
	pnpm run coverage

check: typecheck lint format-check coverage

integration:
	pnpm exec vitest run --config e2e/vitest.e2e.config.ts

integration-verbose:
	SHIP_E2E_VERBOSE=1 pnpm exec vitest run --config e2e/vitest.e2e.config.ts

e2e:
	SHIP_LIVE=1 pnpm exec vitest run --config e2e/vitest.e2e.config.ts

e2e-verbose:
	SHIP_LIVE=1 SHIP_E2E_VERBOSE=1 pnpm exec vitest run --config e2e/vitest.e2e.config.ts

ci: install check integration

clean:
	pnpm exec rimraf -g "**/dist" "**/coverage" "**/*.tsbuildinfo"
