# Responsive composer

Status: Verified
Date: 2026-10-12

## Problem

At the supported 720×480 window size, the default panels leave a 20px textarea. Enlarged text also lets a long draft push Send below the window.

## User flow

The conversation keeps the available width when the window or text size leaves insufficient room for secondary panels. Sidebar and details buttons open modal panels in that layout. Keyboard shortcuts still toggle each panel, Escape closes it, and focus returns to its trigger.

## Design

Keep the 720×480 Electron minimum. Measure window width in the current root font size so panel docking follows both app zoom and text enlargement. Reserve 32rem for a docked conversation, plus 16rem for the sidebar and 24rem for details. Compact panels use the existing Base UI dialog, with separate overlay state from desktop visibility preferences.

The composer toolbar wraps and constrains the model picker. Bound draft growth by 60% of the conversation height and scroll the textarea instead of pushing the actions outside the window. Attachments share that space through a scrollable list, while the textarea retains at least one line. No RPC, database, or security boundary changes.

## Out of scope

Other routes, transcript rendering, and panel content redesign belong to separate issues.

## Verification

Use an isolated production Electron instance through `verify-kkcode`. Measure the textarea, form, and Send/Stop bounds at 720×480, 200% app zoom, 200% root text sizing, and 320 CSS pixels. Type short and long drafts. Open both panels with the keyboard and close them with Escape. Check both light and dark themes. Playwright BDD scenarios retain the original failing reproduction.

The original eight cases fail before the fix. The full Electron suite passes after it, including the native minimum window at 200% zoom, image attachments, and dialog focus restoration. Live textarea widths are 634px at 720×480, 234px at 320 CSS pixels, and 550px with doubled text at 720×480. Send stays inside the viewport in both themes. Busy-state checks seed a running thread without starting a paid agent turn.

With the compact sidebar closed, Ctrl+N and Ctrl+Shift+N still open their dialogs and Escape dismisses them.
