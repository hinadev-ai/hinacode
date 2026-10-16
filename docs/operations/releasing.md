# Releasing

Use this to publish kkcode for macOS (arm64), Windows (x64) and Linux (x64) to `kjj6198/kkcode-releases`, where installed apps pick it up as an update.

The `Build` workflow builds macOS on the home Mac runner, and Linux and Windows on `ubuntu-latest` in the `electronuserland/builder:24-wine` image. A pull request that changes packaging gets unsigned builds as workflow artifacts. A `v*` tag gets a signed, notarized macOS build and a release.

## Steps

1. Once, create the public feed repository with a first commit: `gh repo create kjj6198/kkcode-releases --public --add-readme`. GitHub refuses to create a release in an empty repository.
2. Once, add these repository secrets to `kjj6198/kkcode`:

   | Secret                     | Value                                                                       |
   | -------------------------- | --------------------------------------------------------------------------- |
   | `MAC_CERTIFICATE_P12`      | The Developer ID Application certificate exported as `.p12`, base64 encoded |
   | `MAC_CERTIFICATE_PASSWORD` | The `.p12` password                                                         |
   | `APPLE_API_KEY_P8`         | The contents of `AuthKey_XXXX.p8`                                           |
   | `APPLE_API_KEY_ID`         | The key id                                                                  |
   | `APPLE_API_ISSUER`         | The issuer uuid                                                             |
   | `RELEASES_TOKEN`           | A token that can write releases to `kjj6198/kkcode-releases`                |

3. Bump `version` in `package.json` and merge it to `main`.
4. Tag that commit and push the tag:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

   The `draft` job checks that the tag matches `package.json` and creates a draft release. The build jobs upload the DMG, the macOS zip, the Windows installer, the AppImage, their blockmaps, and `latest-mac.yml`, `latest.yml` and `latest-linux.yml` into it, and the `release` job publishes it. Installers skip Actions artifact storage, so its quota cannot block a release. If a build job fails, rerun the failed jobs; the upload replaces assets already in the draft.

For a local build without signing or publishing, run `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist -c.mac.notarize=false`. It builds for the current platform, and the output lands in `dist/`.

## If it goes wrong

- **The app quits at startup with `ERR_MODULE_NOT_FOUND`.** A main-process import pulls in a package that is not packaged. Only packages that `out/main` imports belong in `dependencies`; the renderer is bundled by Vite, so its packages are `devDependencies`. Import a subpath instead of a barrel (for example `@effect/platform-node/NodeHttpServer`), or move the package to `dependencies`.
- **A thread says its agent is not installed.** The app ships no agent CLI. It runs the user's own `claude`, `codex` or `muse`, found with `which <name>`, then `$SHELL -ilc 'command -v <name>'`. Run both in a terminal to see which one misses.
- **Installed apps do not update.** Check that the release is published, not a draft, and that it has the `latest*.yml` for that platform. Squirrel.Mac also refuses a build signed with a different identity than the running app.
- **The Windows build fails in `wine`.** It needs real x64. Wine crashes under Docker's x64 emulation on Apple Silicon, so build Windows in CI.
