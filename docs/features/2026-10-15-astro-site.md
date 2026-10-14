# Astro marketing site

Status: Shipped
Date: 2026-10-15

## Problem

The marketing site has two standalone HTML pages with duplicated navigation and download links. It has no build or deployment command. Move it to Astro and Tailwind while preserving its design and interactive demo.

## User flow

Visitors open the landing page, try the approval and steering demo, and follow Pricing to the free plan. Download links and keyboard hints still adapt to the visitor's platform. The existing `pricing.html` URL redirects to the pricing page on Workers.

Maintainers run `pnpm --dir site dev` from the repository and deploy with `pnpm --dir site deploy` after signing into Cloudflare.

## Design

Add `site` as a pnpm workspace package with static Astro pages. Extract a shared layout, navigation, footer, and download button. Tailwind 4 supplies the theme and common styling; retain custom CSS for the detailed demo, receipt, and existing motion. Keep the browser demo in a page-specific script and share platform detection between pages.

Build HTML, CSS, and JavaScript into `site/dist`. Wrangler serves that directory with Workers Static Assets. The pages do not need server rendering or a Worker entry point. This follows [Cloudflare's static Astro deployment guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/).

## Out of scope

New copy, a new visual design, backend services, and publishing to a Cloudflare account. This change prepares and verifies deployment locally.

## Verification

Compare the original and built pages at desktop and mobile widths with fonts loaded and animations pinned. Exercise Allow, Deny, Replay, steering, FAQ disclosure, navigation, platform labels, and keyboard hints. Run Astro checking and build, Wrangler deployment dry run, a local Workers preview, and the repository's typecheck, lint, and tests.

Eight comparisons at desktop and mobile widths have zero changed pixels. The comparison caught a dropped standard `backdrop-filter` during CSS minification and a changed navigation line height from Tailwind; both are corrected. The approval buttons and shortcuts, replay, steering, FAQ, and page navigation work in the local Workers preview. The build, Astro checks, deployment dry run, and repository checks pass.
