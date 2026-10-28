set -e
pw="pnpm exec playwright test -c e2e/playwright.config.ts --workers=$E2E_WORKERS --shard=$E2E_SHARD"
pnpm exec bddgen -c e2e/playwright.config.ts
$pw --project parallel
$pw --project desktop --no-deps
