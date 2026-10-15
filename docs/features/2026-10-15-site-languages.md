# Marketing site languages

Status: Shipped
Date: 2026-10-15

## Problem

The marketing site is English-only. Chinese and Japanese readers need the same landing page, pricing details, and interactive demo in their language.

## User flow

The navigation offers English, 繁體中文, and 日本語. A language link opens the current page in that language. English keeps `/` and `/pricing/`; Traditional Chinese uses `/zh-tw/` and `/zh-tw/pricing/`, and Japanese uses `/ja/` and `/ja/pricing/`. Links within a page retain its language.

## Design

Define a `Locale` union for `en`, `zh-TW`, and `ja`, and a page union for landing and pricing. Render one shared Astro component per page with the selected locale. Store all new copy under `site_` keys in the existing `messages/en.json`, `messages/zh-TW.json`, and `messages/ja.json` catalogs.

Render demo responses as localized HTML templates at build time. The browser clones those templates during approvals, replay, and steering. It does not parse translated HTML or download the desktop application's catalogs. Use language-specific CJK font fallbacks and keep the current visual design.

Astro generates all six routes as static files. Workers deployment stays the same. Set the document language for each page. When `SITE_URL` supplies the public origin, emit absolute canonical and alternate language URLs; omit those metadata links during local builds without a configured origin.

## Out of scope

Browser-language redirects, saved language preferences, Simplified Chinese, desktop UI changes, and publishing to Cloudflare.

## Verification

First build all six routes and check catalog key and placeholder parity. Then drive the language links and both demo outcomes in Chinese and Japanese in a local Workers preview. Inspect desktop and mobile screenshots for wrapping and overlap. Finish with Astro checking, the Workers dry run, and the repository's typecheck, lint, and tests.

All six routes and their internal links return successfully in the local Workers runtime. Both translated demos support approval, denial, replay, and steering. Language switching preserves pricing routes and landing-page anchors. Header checks at 800, 768, 390, and 320 pixels found no overflow. Screenshot review caught a split Japanese emphasis word; keep emphasized words together with `white-space: nowrap`. Build verification checks absolute language metadata with `SITE_URL` and its omission without an origin. Catalog checks, Astro checks, the deployment dry run, and repository checks pass.
