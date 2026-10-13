# Releasing

Use this to publish a signed, notarized macOS arm64 build to `kjj6198/kkcode-releases`, where installed apps pick it up as an update.

## Steps

1. Once, create the public feed repository: `gh repo create kjj6198/kkcode-releases --public`.
2. On an Apple Silicon Mac, install the Developer ID Application certificate in the login keychain.
3. Bump `version` in `package.json` and merge it to `main`.
4. Export the notarization key and a token that can write releases to `kjj6198/kkcode-releases`:

   ```sh
   export APPLE_API_KEY=/path/to/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=<issuer uuid>
   export GH_TOKEN=<token>
   ```

5. Build, sign, notarize and publish:

   ```sh
   pnpm install
   pnpm release
   ```

   This uploads `kkcode-<version>-arm64.dmg`, `kkcode-<version>-arm64-mac.zip`, their blockmaps and `latest-mac.yml` to a release named after the version.

For a local build without signing or publishing, run `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist`. The output lands in `dist/`.

## If it goes wrong

- **The app quits at startup with `ERR_MODULE_NOT_FOUND`.** A main-process import pulls in a package that is not packaged. Only packages that `out/main` imports belong in `dependencies`; the renderer is bundled by Vite, so its packages are `devDependencies`. Import a subpath instead of a barrel (for example `@effect/platform-node/NodeHttpServer`), or move the package to `dependencies`.
- **Claude threads fail to start in the packaged app.** Check that `Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` exists in the build.
- **Installed apps do not update.** Check that the release is published, not a draft, and that it has `latest-mac.yml`. Squirrel.Mac also refuses a build signed with a different identity than the running app.
