# HTML in Markdown

## Problem

Markdown reaches the renderer from sources with different conventions.
Pull request bodies and bot comments are written for GitHub's renderer and
contain raw HTML: deploy-status tables, `<details>` folds, `<picture>`
badges with light and dark variants. Agent replies are prose and contain
tag-shaped placeholders such as `<hostname>` that are not HTML at all.
File previews sit between the two, since READMEs use HTML for centered
images and badges.

Parsing every document as HTML is wrong in both directions. It costs a
full HTML reparse of every message, and it silently deletes placeholder
words from agent prose. Never parsing HTML leaves bot comments as visible
markup.

Services also append delimited blocks to PR bodies, for example
`<!-- codesmith:footer -->` … `<!-- /codesmith:footer -->` around two
badge links and a help note. Rendered as generic HTML, the badges use
their 3x intrinsic size and the scheme variant follows the OS instead of
the app theme.

## Design

One module, `src/renderer/lib/htmlInMarkdown.ts`, serves every
source. Four stages, each with a fast path.

1. **Segment service blocks.** A linear scan, only when `<!--` appears,
   splits out blocks delimited by registered marker pairs. A block whose
   links and badge images parse cleanly renders as a native badge strip:
   alt text as the label, the image variant chosen by the app color
   scheme, the trailing `<sup>` note as muted text. A block that does
   not parse stays in the Markdown flow and renders as generic HTML, so
   a format change degrades to today's behavior instead of hiding
   content. Marker styles found in the wild, and how they land:
   - Delimited promo footers (codesmith): the badge strip.
   - Auto-generated summaries wrapped in start and end markers
     (CodeRabbit, React Doctor, bundle-size): the content is the main
     text, so markers are dropped and the content renders normally.
   - Fingerprint and state markers (`coderabbit:fingerprint:…`,
     `codesmith:autofix:disabled`, `Preview URL`): dropped.
   - Deploy tables (Cloudflare, Vercel) and `<details>` folds
     (CodeRabbit, React Doctor, Codecov): generic HTML.

2. **Guard raw HTML in the Markdown tree.** A remark pass inspects each
   `html` node. Comments are removed. A node whose tag is in the
   renderable set stays HTML. Anything else, `<hostname>`, `<Suspense>`,
   `<your-name>`, becomes a text node with the same characters, so prose
   keeps its words. Code spans and fences never produce `html` nodes, so
   code is untouched by construction. The lightweight renderable set is
   tested against the sanitize schema's tag list, so the guard cannot
   admit a tag the sanitizer would drop.

3. **Load and parse HTML only when it can survive.** A cheap source scan
   decides whether the separate HTML chunk is needed at all, keeping the
   parser out of the startup bundle. Agent prose with only placeholders
   never loads it. Once loaded, a rehype pass walks the parsed tree with
   early exit looking for a `raw` node, so markup inside a code fence
   does not trigger a parse. When a `raw` node exists, `rehype-raw`
   parses it and `rehype-sanitize` applies the GitHub-modelled schema,
   extended with `srcSet` and `sizes` so `<picture>` works. The plain
   render stays visible while the chunk loads.

4. **Render with app components.** Images honor `width` and `height`
   attributes, so badges keep their intended size. A `<source>` whose
   `prefers-color-scheme` media contradicts the app scheme is dropped,
   so `<picture>` follows the app theme instead of the OS. Web images
   load through the `hinacode-image:` protocol, because the page policy
   refuses direct web loads. The main process fetches them without
   credentials, follows redirects by hand, and only serves responses
   that declare an image type. Targets on local networks are refused,
   so a comment cannot make the app probe the network around the user.
   A hostname that resolves to a local address is not caught by that
   check; the request still carries no credentials and only ever
   returns data to an image element.

### Why not a WASM parser

A WASM Markdown engine returns an HTML string. Rendering it means
`dangerouslySetInnerHTML`, which gives up the React component mapping
this renderer depends on: syntax highlighting, Mermaid diagrams, find
highlight marks, link handling, image source resolution. It also makes
parsing cost uniform, so the common no-HTML message pays full price.
The stage-3 early exit makes the common case cheaper than any parser
swap, with no rendering changes.

## Out of scope

- Per-service renderers beyond the badge strip. A new delimited block
  is one registry entry plus a parser when a real example shows up.
- Streaming partial-HTML repair. Replies render as Markdown only when
  the turn part is done (`ReplyText`), so half-written tags never reach
  the renderer.
- Block-level render memoization. Stage 3 removes the HTML cost; if
  profiling later shows the Markdown parse itself hot during streaming,
  block caching slots in at the segment layer.

## Verify

- `htmlInMarkdown.test.ts` covers the guard (`<hostname>` survives,
  `<br>` renders), the conditional parse (identity return without raw
  nodes), sanitizing, and badge-block parsing with fallback.
- In the app, open PR #456: the codesmith footer shows as a badge
  strip, the Cloudflare comment as a table, the React Doctor comment
  with a working `<details>` fold.
