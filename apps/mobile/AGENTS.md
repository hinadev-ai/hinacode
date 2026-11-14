This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

This app is a pnpm project of its own, outside the root workspace. Run `pnpm install` here and at the repository root, because `tsc` resolves the `effect` types of `src/shared` from the root.

```bash
pnpm exec expo install <package>  # add a dependency at the version the Expo SDK supports
pnpm start                        # start Metro for a development build that is already installed
pnpm ios                          # build and install the development build on an iOS simulator or device, then start Metro
pnpm android                      # the same on an Android emulator or phone
pnpm install:ios                  # build a standalone Release app and install it on the connected iPhone or iPad
pnpm install:android              # build a Release APK and install it on the phone adb sees
pnpm lint                         # oxlint with the root .oxlintrc.json, the same rules as the desktop renderer
pnpm exec tsc --noEmit            # typecheck, as CI does
```

Run the unit tests from the repository root with `pnpm exec vitest run --project mobile`. That project covers `src/lib/*.test.ts` and `src/stores/*.test.ts`.

Run lint, typecheck and the unit tests before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Native builds

There is no EAS config. Every build runs on this machine. Use the `pnpm` scripts rather than `expo run:*`, because they set the environment the native builds need (`README.md`). `pnpm install:ios` and `pnpm install:android` regenerate `ios/` or `android/` with `expo prebuild`, then put back the `app.json` and `package.json` that prebuild rewrites.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go cannot run this app, because replies render through `react-native-enriched-markdown`, a native Fabric component. Build the development build again with `pnpm ios` or `pnpm android` after adding a library with native code.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
