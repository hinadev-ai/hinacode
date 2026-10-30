---
name: HinaCode site
description: The marketing site as a 2 a.m. dial-up bulletin board, where your agents are the callers online and the one that needs you pages you
colors:
  black: "#000000"
  blue: "#0000aa"
  cyan: "#00aaaa"
  magenta: "#aa00aa"
  brown: "#aa5500"
  gray: "#aaaaaa"
  dark-gray: "#555555"
  bright-blue: "#5555ff"
  bright-green: "#55ff55"
  bright-cyan: "#55ffff"
  bright-red: "#ff5555"
  bright-magenta: "#ff55ff"
  yellow: "#ffff55"
  white: "#ffffff"
typography:
  closing:
    fontFamily: "IBM VGA, Cubic 11, DotGothic16, ui-monospace, monospace"
    fontSize: "64px"
    fontWeight: 400
    lineHeight: 1.1
  hero:
    fontFamily: "IBM VGA, Cubic 11, DotGothic16, ui-monospace, monospace"
    fontSize: "48px"
    fontWeight: 400
    lineHeight: 1.17
  display:
    fontFamily: "IBM VGA, Cubic 11, DotGothic16, ui-monospace, monospace"
    fontSize: "32px"
    fontWeight: 400
    lineHeight: 1.25
  body:
    fontFamily: "IBM VGA, Cubic 11, DotGothic16, ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  chrome:
    fontFamily: "IBM VGA, Cubic 11, DotGothic16, ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1
rounded:
  none: "0px"
spacing:
  gutter: "24px"
  gutter-compact: "16px"
  field: "96px"
  field-compact: "64px"
  frame: "1200px"
components:
  download-key:
    backgroundColor: "{colors.bright-cyan}"
    textColor: "{colors.black}"
    typography: "{typography.chrome}"
    rounded: "{rounded.none}"
    padding: "16px 20px"
  download-key-hover:
    backgroundColor: "{colors.white}"
    textColor: "{colors.black}"
  link:
    textColor: "{colors.bright-cyan}"
  link-hover:
    backgroundColor: "{colors.bright-cyan}"
    textColor: "{colors.black}"
  status-bar:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.white}"
    height: "48px"
  page-box:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.white}"
    padding: "12px 16px"
  key-button:
    textColor: "{colors.white}"
    padding: "8px 12px"
  key-button-hover:
    backgroundColor: "{colors.bright-blue}"
  key-button-strong:
    backgroundColor: "{colors.white}"
    textColor: "{colors.blue}"
    padding: "8px 12px"
  key-button-strong-hover:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.blue}"
  code-chip:
    backgroundColor: "{colors.black}"
    textColor: "{colors.bright-cyan}"
    padding: "0 8px"
  demo-badge:
    backgroundColor: "{colors.dark-gray}"
    textColor: "{colors.white}"
    padding: "0 6px"
  message-row-open:
    backgroundColor: "{colors.cyan}"
    textColor: "{colors.black}"
    padding: "12px 16px"
  message-card:
    textColor: "{colors.gray}"
    padding: "16px 20px"
---

# Design System: HinaCode site

## Overview

**Creative North Star: "The 2 A.M. Nightboard"**

The site is a dial-up bulletin board after midnight. The visitor dials in, the title art pours in, five agents are online and one is paging. Everything is drawn in the material of a DOS text-mode screen: a black ground, the sixteen CGA/ANSI colours, one 8x16 bitmap face, CP437 block and shade glyphs. Warmth comes from full colour fields (brown, magenta) and lit yellow windows, not from gradients or tints. Depth comes from a CRT layer and half-block cast shadows, not from drop shadows.

Density is terminal density: every glyph sits on a 16px cell, controls are hotkeys in brackets, lists use dot leaders, and the FAQ is a message base. The light ticket-rail world (canary yellow, Archivo, Martian Mono, chick mark) was rejected and removed; nothing from it carries over. Dark only.

**Key Characteristics:**

- Sixteen ANSI colours, flat, no tints and no opacity on colour.
- IBM VGA 8x16 at whole multiples only (16, 32, 48, 64).
- Sections change on full colour fields joined by ░▒▓ shade bands, never on ruled lines.
- White on blue means a live event or a page.
- Hand-drawn half-block wordmark, CP437 starfield and skyline.
- Every control is a key: [1]..[4], [G], A and D.

## Colors

The CGA/ANSI sixteen, used flat at full strength on a black ground.

### Primary

- **Phosphor Bright Cyan** (bright-cyan): the action colour. Download key ground, links, menu bracket glyphs, code chip text, top wordmark band.
- **ANSI Blue** (blue): the paging colour. Status bar, the needs-you agent row, the page box, kbd caps and the wordmark's cast shadow.

### Secondary

- **Terminal Cyan** (cyan): structure. Title frame, message card border, receipt rule, open FAQ row, table headers, language summary, second wordmark band.
- **Bright Magenta / Magenta** (bright-magenta, magenta): lower wordmark bands, the "taste" highlight in the headline, and the closing field.
- **Brown** (brown): the warm section field behind features and costs.

### Tertiary

- **Lit Window Yellow** (yellow): emphasis and hotkeys. Highlighted headline words, kbd letters, dot leaders, receipt total, brand name, lit skyline windows, focus ring.
- **State Greens and Reds** (bright-green, bright-red): working / passed / added lines, and failed / deleted lines.

### Neutral

- **Ground Black** (black): page ground, frame interior, code chip ground, scanline and vignette tint.
- **White** (white): headings and copy on colour fields.
- **Light Gray** (gray): default body text and footer credit.
- **Dark Gray** (dark-gray): only the DEMO badge that marks synthetic board data.
- **Bright Blue** (bright-blue): hover ground for the secondary key button on the page box.

### Named Rules

**The Sixteen Rule.** Only the sixteen ANSI colours appear. No tints, no mixes, no opacity on a colour. The only alpha in the system is black in the CRT layer.

**The Page Rule.** White on blue is reserved for live events and paging: the status bar, the agent that needs you, the page box and kbd caps. Ordinary sections never use it.

**The Field Rule.** A section is a full colour field (black, brown, black, magenta, black). Fields meet through three-row ░▒▓ shade bands in the field's colour, never through a ruled line.

## Typography

**Display Font:** IBM VGA 8x16 (int10h Ultimate Oldschool PC Font Pack, CC BY-SA 4.0, self-hosted woff), weight 400 only
**Japanese:** DotGothic16, on the same 16px grid
**Traditional Chinese:** Cubic 11 (OFL), at 22 / 33 / 44px

**Character:** One bitmap face for everything, rendered without smoothing. Hierarchy comes from size multiples and colour, never from weight or a second Latin face.

### Hierarchy

- **Closing** (400, 64px, 1.1): closing and pricing headlines; 32px below 1024px.
- **Hero** (400, 48px, 1.17): home headline; 32px below 1024px; 44px in zh-TW.
- **Display** (400, 32px, 1.25): section headings, receipt total, wordmark cell size; 33px in zh-TW.
- **Body** (400, 16px, 1.34 to 1.5): ledes, menu descriptions, message bodies; 22px in zh-TW. Measures cap at 34em to 52em.
- **Chrome** (400, 16px, 1): status bar, tables, kbd, code chips, badges, CP437 art rows.

### Named Rules

**The Whole Multiple Rule.** Latin type is set only at 16, 32, 48 or 64px. Any other size breaks the bitmap.

**The Upright CJK Rule.** CJK is never italic, and never set outside its own grid (16px for Japanese, 22/33/44px for Traditional Chinese).

**The Credit Rule.** The font credit sits in the footer.

## Layout

Content centres in a 1200px frame with 24px gutters (16px below 1024px). The title screen is one double-line frame holding the wordmark over a starfield, then two columns (offer left, board up to 520px right, 48px gap), closed by the skyline. Below it, fields pad 96px vertically (64px below 1024px). Feature menus run in auto-fit columns of at least 520px.

Responsive steps: below 1100px the wordmark drops from 32px to 16px cells; below 1024px the title columns stack, the hotkey menu wraps to its own row and scrolls; below 700px the wordmark stacks HINA over CODE; below 600px the agent table collapses to state plus branch.

## Elevation & Depth

No shadows on boxes. Depth is a CRT effect plus pixel art: scanlines inside the title screen only, a global radial vignette, and the wordmark's dark-blue half-block cast shadow offset one pixel down and right.

**The CRT Rule.** Scanlines live only inside the title screen; the vignette covers the viewport. Neither adds colour.

## Shapes

Square everything (0px radius). Borders are double lines in cyan or white, never single rules.

**The Three Lines Rule.** Content carries lines in three places: the double-line frame around the title screen (6px), the message card's double border (4px), and the receipt total's double rule (4px). Popup windows (the page box and the language menu) wear the same double frame.

## Components

### Buttons

- **Download key:** bright cyan ground, black text, `[ ↓ … ]` brackets with a blue arrow, 16px by 20px padding, square. Hover turns the ground white.
- **Key buttons (A / D):** on the page box. Deny is transparent white text, bright-blue on hover; Allow is white with blue text, yellow on hover. Each carries an inverse kbd cap.
- **Focus:** 2px yellow outline, 2px offset, everywhere.

### Links

- Bright cyan with a `» ` prefix; hover inverts to black on bright cyan. On the magenta closing field they turn white and invert to magenta on white.

### Chips

- **Code chip:** black ground, bright-cyan text, 8px side padding, used at the right of feature menu rows and inline in descriptions.
- **DEMO badge:** dark gray ground, white uppercase text. It marks every surface showing synthetic data.

### Navigation

- **Status bar:** sticky, blue, 48px tall. Yellow HINACODE brand with a blinking underscore cursor, live online / needs-you counts, the hotkey menu `[1] Download [2] Features [3] Pricing [4] FAQ [G] GitHub` (yellow keys in bright-cyan brackets, wired to the keyboard), and a cyan language summary opening a blue double-framed menu.

### Agent board (signature)

- One label grid per row: node, agent, branch, state. States colour the label (working bright green, done bright cyan, failed bright red); the needs-you row is white on blue and its state blinks four times.
- **Page box:** white double frame on blue, a white PAGE flag that blinks four times, typed-in lines, then A / D keys. Resolved, it turns black with a cyan frame and cyan flag.

### Feature menu (signature)

- `n) title …… [code chip] »` rows: white number and title, yellow dot leaders, code chip, `»`. Below 1024px the leader and `»` drop and the chip wraps under the title.

### Message base (signature)

- FAQ rows `#01 subject SysOp`; hover and open rows invert to black on cyan. The open card is a cyan double-bordered box with a bright-cyan From / To / Subj header.

### Receipt

- Pricing rates as a dl with bright-cyan amounts, closed by a cyan double rule and a yellow 32px total.

### Title art

- **Wordmark:** HINACODE drawn on an 8-pixel bitmap, rendered in ▀▄█ half-blocks with foreground and background pairs. Bands: bright cyan, cyan, bright magenta, magenta, with a blue cast shadow.
- **Starfield:** CP437 `· . + *` in white, gray, yellow and bright cyan behind the wordmark.
- **Skyline:** authored CP437 blocks with yellow lit windows; blue walls closing the title frame, black walls closing the magenta field.

### Motion

- Wordmark pours in band by band (`steps(5)`, 1300ms). Bright-cyan stars twinkle. Page flags blink four times. Printed lines type in (`steps(24)`, 360ms). The brand cursor blinks four times. All motion is off under reduced motion.

## Do's and Don'ts

### Do:

- **Do** use only the sixteen ANSI colours at full strength on a black ground.
- **Do** set Latin type in IBM VGA at 16, 32, 48 or 64px only.
- **Do** change sections with a full colour field and a three-row ░▒▓ shade band.
- **Do** reserve white on blue for live events, paging and kbd caps.
- **Do** make every control a key: brackets, hotkeys, inverse on hover.
- **Do** mark synthetic data with the dark-gray DEMO badge.
- **Do** step every animation and turn all of it off under reduced motion.

### Don't:

- **Don't** tint, mix or apply opacity to a colour.
- **Don't** separate sections with a ruled line or add lines beyond the three.
- **Don't** use white on blue for an ordinary section.
- **Don't** add a second Latin face, a bold weight, or an off-grid size.
- **Don't** italicise CJK.
- **Don't** round corners or cast box shadows.
- **Don't** loop a page blink; it blinks four times and stops.
- **Don't** add a light theme.
