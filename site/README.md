# hinacode site

## Run locally

Use Node 24 or later and the pnpm version in the root `package.json`.

From the repository root, run:

```sh
pnpm install
pnpm --dir site dev
```

Astro serves the landing page at `/` and pricing at `/pricing/`. Edit pages in `src/pages`, shared markup in `src/components`, and styles in `src/styles/global.css`. The visual system (a dial-up bulletin board in the sixteen ANSI colours) is described in `DESIGN.md`. The IBM VGA and Cubic 11 fonts live in `public/fonts` with their licenses, and DotGothic16 comes from `@fontsource/dotgothic16`.

To check and build the site, run:

```sh
pnpm --dir site check
pnpm --dir site build
```

## Edit translated copy

The language menu switches between English, Traditional Chinese, and Japanese while keeping the current page. English uses `/` and `/pricing/`; Traditional Chinese uses `/zh-tw/` and `/zh-tw/pricing/`; Japanese uses `/ja/` and `/ja/pricing/`.

Edit `site_` keys in the root `messages/en.json`, `messages/zh-TW.json`, and `messages/ja.json` catalogs. Add each key to all three catalogs and keep placeholders identical. `Home.astro` and `Pricing.astro` render all languages from the same markup. `Text.astro` replaces placeholders with named slots so translators can change word order without adding HTML.

The live approval on the home page is driven by `src/scripts/board.ts`. Its localized hints, replies, and pull request lines live in `<template data-board-template>` elements at the end of `Home.astro`. The number keys in the status bar menu are wired in `src/scripts/platform.ts`. All language routes are static, so deploying to Workers uses the same command.

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

Set `SITE_URL` to the site's public origin when building or deploying. Astro then emits absolute canonical and alternate language URLs. For example, run `SITE_URL=https://your-site.example pnpm --dir site deploy`, using your actual domain or `workers.dev` URL. Without `SITE_URL`, the site omits those metadata links and language navigation still works. Set the same variable in Workers Builds if you use it.

For Workers Builds connected to this repository, set the root directory to the repository root, build command to `pnpm --dir site build`, and deploy command to `pnpm --dir site exec wrangler deploy`. The root lockfile covers both the desktop app and the site. For external CI, provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as CI secrets.
