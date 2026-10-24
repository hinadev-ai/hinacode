# HinaCode relay service

A Cloudflare Worker at `relay.hinacode.app`. It links machines to HinaCode accounts with a device-code flow and creates one Cloudflare named tunnel per linked machine. The machine runs `cloudflared` with the connector token it gets back. The service never carries a frame. The design is in `docs/features/2026-10-24-relay.md` and `docs/adr/0020-cloudflare-tunnel-as-the-relay.md`.

`src/app.ts` holds the handlers. `src/index.ts` wires them to Clerk, `fetch` and the clock. `GET /link` serves the approval page from `src/page.ts`, with no build step. `expiresAt` and `createdAt` are milliseconds since the epoch.

## One-time setup

1. Create the database with `pnpm exec wrangler d1 create hinacode-relay`. Put its id in `database_id` in `wrangler.jsonc`, then run `pnpm db:migrate`.
2. Pick a zone on Cloudflare for the tunnel hostnames. Keep it apart from `hinacode.app`, so a page a machine serves never shares an origin with the site. Set `TUNNEL_ZONE_NAME` to the zone's name and `TUNNEL_ZONE_ID` to its id.
3. Set `CLOUDFLARE_ACCOUNT_ID` to the account that owns the zone and the tunnels.
4. Create an API token with two permissions: Account, Cloudflare Tunnel, Edit, and Zone, DNS, Edit on the tunnel zone. Store it with `pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN`.
5. Create a Clerk application with the sign-in methods to offer, such as GitHub, Google and email. Set `CLERK_PUBLISHABLE_KEY` to its publishable key. Store its secret key with `pnpm exec wrangler secret put CLERK_SECRET_KEY`. For the production instance, add `relay.hinacode.app` as the application's domain.

The variables live in `vars` in `wrangler.jsonc`. The two secrets never go in the config. `secrets.required` only names them, so `wrangler types` and `wrangler dev` know about them.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and fill it in. A Clerk development instance and a real zone make the whole flow work. Dummy values are enough to serve the page and create links.
2. Run `pnpm exec wrangler d1 migrations apply DB --local` once.
3. Run `pnpm dev`. The service listens on `http://localhost:8787`. Point HinaCode at it with `HINACODE_RELAY_URL=http://localhost:8787`.

`pnpm test` runs the handlers against real D1 in workerd, with a fake Cloudflare API and a fake Clerk. `pnpm check` regenerates `worker-configuration.d.ts` and type-checks.

## Deploy

Run `pnpm db:migrate` when `migrations/` changed, then `pnpm deploy`. `pnpm deploy:dry-run` builds the Worker without uploading it, as CI does.
