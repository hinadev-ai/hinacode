# kkcode site

## Run locally

Use Node 24 or later and the pnpm version in the root `package.json`.

From the repository root, run:

```sh
pnpm install
pnpm --dir site dev
```

Astro serves the landing page at `/` and pricing at `/pricing/`. Edit pages in `src/pages`, shared markup in `src/components`, and styles in `src/styles/global.css`. Tailwind 4 uses the Vite plugin and the existing site's theme tokens. Custom CSS preserves the demo, receipt, and animations.

To check and build the site, run:

```sh
pnpm --dir site check
pnpm --dir site build
```

## Preview on Workers

Run the built site through Wrangler's local Workers runtime:

```sh
pnpm --dir site preview:worker
```

Wrangler prints the local URL, normally `http://localhost:8787`. This preview includes the `/pricing.html` and `/index.html` redirects defined in `public/_redirects`.

To validate deployment without publishing, run:

```sh
pnpm --dir site deploy:dry-run
```

## Deploy to Cloudflare Workers

Sign into your Cloudflare account, then deploy:

```sh
pnpm --dir site exec wrangler login
pnpm --dir site deploy
```

Wrangler deploys `dist` as Workers Static Assets and prints the `workers.dev` URL. Set `name` in `wrangler.jsonc` to choose the Worker name. This static site needs no server adapter, bindings, or Worker entry point. See [Cloudflare's Astro guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/#if-you-have-a-static-site).

For Workers Builds connected to this repository, set the root directory to the repository root, build command to `pnpm --dir site build`, and deploy command to `pnpm --dir site exec wrangler deploy`. The root lockfile covers both the desktop app and the site. For external CI, provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as CI secrets.
