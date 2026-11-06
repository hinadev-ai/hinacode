# HinaCode relay service

A Cloudflare Worker at `relay.hinacode.app`. It links machines to Clerk accounts with a device-code flow and creates one Cloudflare named tunnel per linked machine. The machine runs `cloudflared` with the connector token it gets back. The service never carries a frame. The design is in `docs/features/2026-10-24-relay.md` and `docs/adr/0020-cloudflare-tunnel-as-the-relay.md`.

`src/app.ts` holds the handlers. `src/index.ts` wires them to Clerk (`src/clerk.ts`), `fetch` and the clock. `GET /link` serves the approval page from `src/page.ts`, with no build step. `expiresAt` and `createdAt` are milliseconds since the epoch.

A linked machine publishes the pairing its QR code carries with `PUT /v1/host/pairing`. `GET /v1/machines` hands an account's devices every machine that published one and is shown, so they can add it without scanning. The desktop's **Show on my devices** switch calls `PATCH /v1/hosts/:id` with `{ enabled }`; a hidden machine's pairing never leaves the relay, and its tunnel keeps running. The design is in `docs/features/2026-10-24-relay-machines.md`.

The web app at `code.hinacode.app` calls the owner routes from the browser, as a signed-in desktop does. `WEB_ORIGINS` lists the origins allowed to call `/v1/*` with CORS, separated by commas.

## One-time setup

1. Create the database with `pnpm exec wrangler d1 create hinacode-relay`. Put its id in `database_id` in `wrangler.jsonc`, then run `pnpm db:migrate`.
2. Pick a zone on Cloudflare for the tunnel hostnames. Keep it apart from `hinacode.app`, so a page a machine serves never shares an origin with the site. Set `TUNNEL_ZONE_NAME` to the zone's name and `TUNNEL_ZONE_ID` to its id.
3. Set `CLOUDFLARE_ACCOUNT_ID` to the account that owns the zone and the tunnels.
4. Create an API token with two permissions: Account, Cloudflare Tunnel, Edit, and Zone, DNS, Edit on the tunnel zone. Store it with `pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN`.
5. Create a Clerk application with Google and GitHub sign-in. Store its keys with `pnpm exec wrangler secret put CLERK_PUBLISHABLE_KEY` and `pnpm exec wrangler secret put CLERK_SECRET_KEY`. A production instance needs its own Google and GitHub OAuth credentials and DNS records, both set in the Clerk dashboard.

The link page signs in through Clerk. The desktop and phone apps open `GET /sign-in`, which redirects back to them with a code they exchange, with their PKCE verifier, for a credential of their own (`docs/features/2026-11-06-sign-in-redirect.md`). The web app still approves itself on the link page. D1 keeps only the credential's hash. **Sign out all devices** on the page ends every credential on the account.

The variables live in `vars` in `wrangler.jsonc`. The secrets never go in the config. `secrets.required` only names them, so `wrangler types` and `wrangler dev` know about them.

## Local development

1. Copy `.env.example` at the repository root to `.env` and fill it in. Sign-in and linking work without a Cloudflare token. Creating a tunnel needs a real one.
2. Run `pnpm exec wrangler d1 migrations apply DB --local` once.
3. Run `pnpm dev`. The service listens on `http://localhost:8787`. Point HinaCode at it with `HINACODE_RELAY_URL=http://localhost:8787`.

`pnpm test` runs the handlers against real D1 in workerd, with a fake Cloudflare API and a fake session. `pnpm check` regenerates `worker-configuration.d.ts` and type-checks.

## Deploy

Run `pnpm db:migrate` when `migrations/` changed, then `pnpm deploy`. Machines linked before Clerk belong to the user id `owner`. To keep them, sign in once and run `pnpm exec wrangler d1 execute DB --remote --command "UPDATE host SET user_id = '<clerk user id>' WHERE user_id = 'owner'"`. Then choose Login on each desktop and phone. `pnpm deploy:dry-run` builds the Worker without uploading it, as CI does.
