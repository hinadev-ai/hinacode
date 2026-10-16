## Design Context

### Users

Developers who run several Claude Code and Codex agents at once across repositories and worktrees. They glance at KKCode between other work. The job is to see which agent needs them (an approval, a question, a failed setup), steer it, review what it changed, and ship the PR. Their attention is the scarce resource, and the UI should spend it only when an agent actually needs a human.

### Brand Personality

**Calm, precise, trustworthy.** A quiet control room. The interface recedes so agent output is the content. The developer should feel confident and in control, never anxious or rushed. Copy is plain and specific, with no exclamation marks and no cheerleading.

### Aesthetic Direction

- **Reference:** Linear. Restrained neutrals, crisp type, tight but breathable density, fast and keyboard-driven, motion that confirms rather than performs.
- **Anti-references:** chat-app bubbles, gradient AI glow, sparkle icons, dashboard confetti, cards inside cards, and color used as decoration.
- **Color:** a grayscale OKLCH base (shadcn neutral in `src/renderer/index.css`) with the brand violet `#7c3aed` from `assets/icon.svg`. Use violet sparingly for focus, the primary action, and "agent is working". Status colors are semantic and stay consistent: amber means it needs you, emerald means it is running, red means failed or destructive. Pull these into tokens instead of scattering raw Tailwind palette classes.
- **Type:** DM Sans Variable for UI, with Noto Sans TC or JP for Han and kana. Code and paths use Paper Mono by defaults. Sizes come from the Tailwind scale plus `text-2xs`, in rem so they follow the font size setting. Rely on weight and size for hierarchy before color.
- **Theme:** light and dark are equal citizens, and every UI change is checked in both. New profiles follow the system appearance. Don't add dark-only assumptions.
- **Motion:** use the easings in `index.css` (`--ease-out` and the rest), keep it short (under 200 ms for UI feedback), and use the `pressable` utility for press feedback. Every animation has a reduced-motion variant.

### Design Principles

1. **Signal over chrome.** Color, motion and badges are reserved for states that need a human. A screen where nothing needs attention should look quiet.
2. **Contrast follows attention.** The agent's reply and the developer's own messages read at full contrast. Tool calls, metadata and anything still in progress recede to `muted-foreground`. Dim with a color token, never with opacity, and never below 4.5:1. See `docs/features/2026-10-14-contrast-hierarchy.md`.
3. **Glanceable state.** Whether a thread is running, waiting, failed or done should be readable from the sidebar alone, without opening the thread.
4. **Keyboard first, pointer friendly.** Every frequent action has a rebindable shortcut, shown as `Kbd`. Hit areas stay generous.
5. **Show the work.** Diffs, worktree paths, commands and PR state are first class and inspectable. Never hide what an agent did behind a summary.
6. **Accessible by default.** Meet WCAG 2.2 AA contrast in both themes and keep focus rings at 3:1. Use roles and accessible names, which also make the UI drivable by `verify-kkcode`. Respect `prefers-reduced-motion`. Never use color as the only signal.
