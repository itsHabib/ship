.PHONY: install lint lint-fix format format-check typecheck test test-watch coverage check ci clean integration e2e

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

coverage:
	pnpm run coverage

check: typecheck lint format-check test

integration:
	pnpm exec vitest run --config e2e/vitest.e2e.config.ts

e2e:
	SHIP_LIVE=1 pnpm exec vitest run --config e2e/vitest.e2e.config.ts

ci: install check coverage integration

clean:
	pnpm exec rimraf -g "**/dist" "**/coverage" "**/*.tsbuildinfo"
