# hinacode site

## Run locally

Use Node 24 or later and the pnpm version in the root `package.json`. From the repository root:

```sh
pnpm install
pnpm --dir site dev
```

Astro serves the landing page at `/` and pricing at `/pricing/`, with Traditional Chinese under `/zh-tw/` and Japanese under `/ja/`.

```sh
pnpm --dir site check
pnpm --dir site build
```

## Layout

- `src/pages` holds the six routes. Each renders `components/Home.astro` or `components/Pricing.astro` with a locale.
- `src/components` holds the sections. Icons come from the app's own set through `src/icons.ts`.
- `src/demo` is the interactive demo, a React island. `engine.ts` runs the threads, `script.ts` says what each thread does, and the rest is UI.
- `src/styles/global.css` holds the Hina Light tokens, fonts and the few animations.

## Edit copy

Copy lives under `site_` keys in the root `messages/en.json`, `messages/zh-TW.json` and `messages/ja.json`. Add each key to all three catalogs with the same placeholders; `src/renderer/messages.test.ts` checks this. The demo also reuses app strings such as `approval_allow`, listed in `src/demo/copy.ts`.

## Preview and deploy

Run the built site in Wrangler's local Workers runtime, normally at `http://localhost:8787`:

```sh
pnpm --dir site preview:worker
pnpm --dir site deploy:dry-run
```

Deploy to Cloudflare Workers after signing in:

```sh
pnpm --dir site exec wrangler login
pnpm --dir site deploy
```

Set `SITE_URL` to the public origin when building or deploying, for example `SITE_URL=https://hinacode.app pnpm --dir site deploy`. Astro then emits canonical, alternate language and `og:image` URLs. Without it the site omits those tags.

For Workers Builds connected to this repository, set the root directory to the repository root, the build command to `pnpm --dir site build`, and the deploy command to `pnpm --dir site exec wrangler deploy`.
