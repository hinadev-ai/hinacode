# Releasing

Build the macOS arm64 zip and the Linux x64 AppImage on a Linux machine and publish them as a GitHub release.

## Steps

1. Install [rcodesign](https://github.com/indygreg/apple-platform-rs/releases) and put it on `PATH`. Apple Silicon refuses to run unsigned binaries, so the mac build gets an ad-hoc signature.
2. Set `version` in `package.json`, then build:

   ```sh
   pnpm install
   pnpm dist
   ```

   This writes `dist/kkcode-<version>-arm64-mac.zip` and `dist/kkcode-<version>.AppImage`.

3. Publish:

   ```sh
   gh release create v<version> dist/kkcode-<version>-arm64-mac.zip dist/kkcode-<version>.AppImage --title <version> --generate-notes
   ```

## Notes

- Only the main-process packages are `dependencies`. The renderer is bundled by Vite, so its packages are `devDependencies` and stay out of the app. Add a package to `dependencies` only if `out/main` imports it.
- `pnpm-workspace.yaml` sets `supportedArchitectures` so pnpm installs the Claude SDK binary for every target platform, not just the build machine's.
- The mac app is not notarized. On first launch, users right-click the app and choose Open, or run `xattr -dr com.apple.quarantine kkcode.app`.

## If it goes wrong

- **The app quits at startup with `ERR_MODULE_NOT_FOUND`.** A main-process import pulls in a package that isn't packaged. Import a subpath instead of the barrel (for example `@effect/platform-node/NodeHttpServer`), or move the package to `dependencies`.
- **Claude threads fail to start in the packaged app.** Check that `app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude` exists in the build.
