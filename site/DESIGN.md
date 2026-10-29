---
name: HinaCode site
description: The marketing site as a kitchen pass, where every agent is an order ticket on one steel rail
colors:
  canary: "#ffd43b"
  ink: "#1b1d26"
  ink-2: "#474a54"
  ink-3: "#5f626c"
  ink-hover: "#343744"
  paper: "#fdfdfb"
  ground: "#ecedea"
  line: "#d3d5d0"
  steel: "#b4b7b2"
  steel-highlight: "#e4e6e2"
  steel-shadow: "#7d817d"
  red: "#c0352b"
  green: "#22714a"
typography:
  display:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.875rem, 1.1rem + 5.4vw, 5.75rem)"
    fontWeight: 760
    lineHeight: 0.94
    letterSpacing: "-0.012em"
    fontVariation: "'wdth' 72"
  closing:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3rem, 0.8rem + 7.4vw, 7.5rem)"
    fontWeight: 800
    lineHeight: 0.9
    fontVariation: "'wdth' 68"
  headline:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 1.3rem + 2.8vw, 3.75rem)"
    fontWeight: 760
    lineHeight: 0.98
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 74"
  title:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 650
    lineHeight: 1.3
    fontVariation: "'wdth' 88"
  body:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  lede:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.0625rem, 1rem + 0.25vw, 1.1875rem)"
    fontWeight: 400
    lineHeight: 1.55
  ticket:
    fontFamily: "Martian Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.5
    fontVariation: "'wdth' 87.5"
  stamp:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.08em"
    fontVariation: "'wdth' 90"
rounded:
  stamp: "3px"
  key: "4px"
  button: "6px"
spacing:
  gutter: "clamp(20px, 3vw, 32px)"
  frame: "1280px"
  rail-gap: "16px"
  section: "clamp(88px, 10vw, 144px)"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.button}"
    padding: "0 20px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "0 12px"
    height: "34px"
  ticket:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.ticket}"
    padding: "18px 14px 23px"
    width: "236px"
  ticket-needs:
    backgroundColor: "{colors.canary}"
    textColor: "{colors.ink}"
  stamp:
    textColor: "{colors.ink-2}"
    typography: "{typography.stamp}"
    rounded: "{rounded.stamp}"
    padding: "4px 9px 3px"
  stamp-failed:
    textColor: "{colors.red}"
  nav:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink-2}"
    height: "64px"
  closing-field:
    backgroundColor: "{colors.canary}"
    textColor: "{colors.ink}"
---

# Design System: HinaCode site

## Overview

**Creative North Star: "The Pass"**

The site is the pass of a kitchen. Every agent is an order ticket of white thermal paper hanging from one flat steel rail over a pale steel-grey counter. Carbon blue-black ink does almost all of the work. Canary yellow, the kitchen copy of a duplicate order pad, is the only colour, and it means one thing: this needs you.

Density is that of a working ticket: small condensed mono for the data, large condensed Archivo for the headers, dotted leaders and dashed tear rules instead of boxes. Torn bottom edges, rotated ink stamps and the rail are the materials; there are no cards, no visible gradients and no glow. The world is light only. The desktop app keeps its own violet system and none of it crosses over.

**Key Characteristics:**

- One steel rail, tickets of ragged lengths hanging from it.
- Canary on exactly one ticket at a time, plus the mark and the closing field.
- State named by a stamp in words and shape, never colour alone.
- Condensed Archivo headers, Martian Mono for numbers, branches, code and receipt lines.
- Flat paper with a single soft drop shadow; dotted and dashed rules for structure.

## Colors

A near-monochrome ink-on-paper palette with one signal colour and two diff colours.

### Primary

- **Canary Order Pad** (canary): "Needs you." The background of the one ticket awaiting a human, the body of the chick mark on light grounds and in the favicon, and the full-bleed closing field. Ink always sits on it.

### Tertiary

- **Order-Number Red** (red): failure only. The FAILED stamp and diff deletions. On canary it darkens to `#a32b22` to hold contrast.
- **Diff Green** (green): diff additions only, darkened to `#1d5e3d` on canary. Never a success or DONE colour.

### Neutral

- **Carbon Ink** (ink): text, primary buttons, focus ring, the chick's eye, beak and tuft, and the favicon tile.
- **Faded Ink** (ink-2): ledes, nav links, menu descriptions, footer.
- **Pale Ink** (ink-3): ticket headers, branch names, verbs, fine print.
- **Thermal Paper** (paper): tickets, receipt, language menu, the chick body on canary.
- **Counter Grey** (ground): the page.
- **Hairline** (line): section and FAQ rules, nav underline.
- **Steel** (steel): the rail band, and the dotted and dashed rules inside tickets and leaders.
- **Steel Highlight / Steel Shadow** (steel-highlight, steel-shadow): the 1px light top rule and 1px dark bottom rule of the rail.

### Named Rules

**The Needs-You Rule.** Canary appears only on the ticket that needs a human, in the mark, and as the page-scale closing field. No highlights, link underlines, badges or decorative canary.

**The Ink-Means-Fine Rule.** DONE, passing, merged and allowed are ink. Red is failure and diff deletions; green is diff additions and nothing else.

## Typography

**Display Font:** Archivo Variable (width axis, real italic), self-hosted via @fontsource-variable, falling back to ui-sans-serif
**Body Font:** Archivo Variable at normal width
**Label/Mono Font:** Martian Mono Variable at 87.5% width, self-hosted via @fontsource-variable
**CJK:** Noto Sans JP Variable (ja) and Noto Sans TC Variable (zh-TW), chained after Archivo

**Character:** Archivo squeezed to 68 to 74% width reads like a printed pad header; Martian Mono reads like a till roll. The width axis, not weight alone, carries hierarchy.

### Hierarchy

- **Display** (760, wdth 72): the hero headline, left-aligned, balanced. Its emphasis words use Archivo's real italic at 460 or an ink underline.
- **Closing** (800, wdth 68): the closing-field headline, with a 420 italic second line.
- **Headline** (760, wdth 74): section heads.
- **Title** (650, wdth 85 to 92): ticket titles, menu items, FAQ questions.
- **Body / Lede** (400, normal width): body copy capped near 34 to 40em; ledes in Faded Ink.
- **Ticket** (Martian Mono 400, 10.5 to 11.5px): order numbers, agent names (uppercase), branches, command lines, code, prices.
- **Stamp** (Archivo 700, wdth 90, 11px, 0.08em, uppercase): state labels.

### Named Rules

**The Width-Not-Weight Rule.** Headers are condensed; data is mono. Do not use a system display face or set headings at normal width.

**The No-Fake-Italic Rule.** In ja and zh-TW the italic emphasis turns upright, headlines drop to smaller sizes with line-height 1.15 to 1.2 and zero tracking, and ja uses `word-break: auto-phrase`.

## Layout

A 1280px frame with a fluid gutter. At 1200px and wider, the first viewport is a 12-column grid: the steel rail spans the full window under the nav, five tickets hang from it on subgrid columns (2, 2, 2, 3, 2 spans with a one-column gap before the canary ticket), and the headline sits left beneath the short tickets in columns 1 to 7. The canary ticket is wider and hangs lowest. Below 1200px the rail becomes a horizontal scroll-snap strip above the headline, with the canary ticket ordered first, and the steel band is drawn into the strip's own background. Sections start 88 to 144px apart; the closing field follows after 104 to 168px. Features are a two-column menu of items joined by dotted leaders to their mono tool names; leaders drop under 760px.

## Elevation & Depth

Flat paper on a flat counter. Depth comes from one soft drop shadow under each ticket and a short shadow under the rail, so tickets read as hanging rather than lifted.

### Shadow Vocabulary

- **Ticket hang** (`filter: drop-shadow(0 1px 1px rgb(27 29 38 / 0.14)) drop-shadow(0 10px 12px rgb(27 29 38 / 0.08))`): every ticket and the receipt; a filter so it follows the torn edge.
- **Rail lip** (`box-shadow: 0 3px 5px -2px rgb(27 29 38 / 0.24)`): under the steel band.
- **Menu float** (`box-shadow: 0 1px 2px rgb(27 29 38 / 0.12), 0 12px 28px -8px rgb(27 29 38 / 0.22)`): the language menu only.

### Named Rules

**The Flat Steel Rule.** The rail is a flat steel band (16px) with a 1px light top rule and a 1px dark bottom rule. Never a gradient, sheen or bevel.

## Shapes

Paper is square-cornered and tears. Ticket bottoms are a 7px zigzag cut with a conic-gradient mask; the closing field's top edge is the same tear at 9px, as if torn off the pad. Corners elsewhere are small: 3px stamps and code wells, 4px keycaps and focus ring, 6px buttons and menu. Stamps are outlined in currentColor at 1.5px and rotated -2deg. Inside paper, structure is dashed rules under headers and dotted rules above line lists; leaders are dotted.

The mark is a chick (hina) whose beak is a prompt chevron. On light grounds: canary body, ink eye, beak and tuft. In the closing field the body turns paper white. The favicon is an ink rounded tile with a canary chick.

## Components

### Buttons

- **Shape:** gently rounded (6px), 1.5px ink border.
- **Primary:** ink fill, paper text, Archivo 600 at normal width, 48px tall; hover lifts to `#343744`, active nudges down 1px.
- **Quiet:** transparent with ink border and text; hover tints with 8% ink.
- **Small:** 34px tall; carries a mono keycap (`A`, `D`) bordered in 45% currentColor.
- **Link:** Archivo 600 with a 2px steel underline offset 5px that turns ink on hover; on canary it starts ink and clears on hover.

### Ticket (signature)

Thermal-paper slip in Martian Mono: header row of order number and agent in uppercase Pale Ink over a dashed rule, a condensed Archivo title, an ellipsised branch, a dotted-rule line list, and a stamp. States are one ladder: WORKING (spinner ring), NEEDS YOU (filled dot, canary slip, ink stamp), DONE (check), FAILED (cross, red stamp). The live canary ticket carries an inline approval with a command well, Deny (quiet) and Allow (primary) with A and D keys; new lines print in with a 420ms top-down reveal.

### Receipt

The pricing ticket: mark and number header, dotted-leader rows of item and price, a dashed rule, a condensed total, and a stamp.

### Navigation

Sticky on Counter Grey with a 1px hairline beneath, 64px tall. Brand is the chick plus "HinaCode" at 750 weight and 112% width. Links in Faded Ink turn ink on hover or current page; links hide under 760px. Language is a details menu on paper.

### Closing Field

Full-bleed canary with a torn top edge, the largest condensed headline, Download and GitHub link, and a large paper-bodied chick bleeding off the bottom right.

## Do's and Don'ts

### Do:

- **Do** keep canary to the one ticket that needs a human, the mark and the closing field.
- **Do** name every state with a stamp label and mark shape, and keep DONE and passing in ink.
- **Do** draw the rail flat: `#b4b7b2` band, 1px `#e4e6e2` above, 1px `#7d817d` below.
- **Do** set headers in condensed Archivo and all ticket data, code and numbers in Martian Mono.
- **Do** self-host fonts via @fontsource-variable and keep CJK upright.
- **Do** build structure from dashed and dotted rules and torn edges on paper.

### Don't:

- **Don't** use canary for highlights, link underlines, badges or decoration.
- **Don't** use green for success or red for anything but failure and deletions.
- **Don't** add cards, visible gradients or glow, or a dark hero over a glowing screenshot. Gradients used as masks for torn edges and as flat rule fills are the world's own material.
- **Don't** add a dark theme; the site is light only.
- **Don't** borrow the desktop app's violet accent or the retired two-ring mark.
