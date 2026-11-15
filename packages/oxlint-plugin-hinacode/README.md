# oxlint-plugin-hinacode

The oxlint rules HinaCode lints itself with. Most of them target React 19 apps built with the React Compiler and Tailwind.

## Install

```sh
pnpm add -D oxlint oxlint-plugin-hinacode
```

Register the plugin in `.oxlintrc.json` and turn on the rules you want:

```json
{
  "jsPlugins": [{ "name": "hinacode", "specifier": "oxlint-plugin-hinacode" }],
  "rules": {
    "hinacode/no-manual-memo": "error",
    "hinacode/no-async-on-click": "error"
  }
}
```

## Rules

| Rule                                | Reports                                                                                                                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-manual-memo`                    | `useMemo`, `useCallback` and `memo`, which the React Compiler already does.                                                                                                                                                         |
| `no-async-on-click`                 | An `onClick` that starts async work (an async handler, `void promise()`, or a call to a local async function) without a pending state, so a second click can run it twice. Menu items are exempt because the menu closes on select. |
| `prefer-start-transition`           | A click or submit handler that sets state outside a transition.                                                                                                                                                                     |
| `no-promise-state-in-effect`        | An effect that stores a promise result in state instead of loading it with `use()` or a data library.                                                                                                                               |
| `no-wall-clock-in-test`             | Timers, `Date.now()` and `new Date()`. Turn it on in an `overrides` entry for your test files.                                                                                                                                      |
| `no-responsive-padding-on-scroller` | Size-conditional padding such as `md:px-4` or `@md:pe-8` on a scroll container, which moves the content and the scrollbar as the space changes.                                                                                     |
| `stable-scrollbar-gutter`           | A scroll container without a `scrollbar-gutter-*` class, whose scrollbar shifts the layout when it appears.                                                                                                                         |
| `allergic-to-sparkling-icon`        | `Sparkle`, `Sparkles` and `Sparkling` icons imported from `react-icons`.                                                                                                                                                            |
| `no-comments`                       | Comments other than tool directives and `FIXME:` workarounds.                                                                                                                                                                       |

## Develop

The rules live in `src/`, one file per rule with a `*.test.ts` next to it. The HinaCode repository runs the tests with `pnpm test` and lints itself with the source directly. `pnpm pack` and `pnpm publish` build `dist/` first and point `exports` at it.
