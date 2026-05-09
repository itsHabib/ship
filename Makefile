.PHONY: install lint lint-fix format format-check typecheck test test-watch coverage check ci clean

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

ci: install check coverage

clean:
	pnpm exec rimraf -g "**/dist" "**/coverage" "**/*.tsbuildinfo"
