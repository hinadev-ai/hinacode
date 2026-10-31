# Releasing

Use this to publish HinaCode for macOS (arm64), Windows (x64) and Linux (x64) as a GitHub release of this repository, where installed apps pick it up as an update.

The `Build` workflow builds macOS on a Blacksmith macOS runner, and Linux and Windows on `ubuntu-latest` in the `electronuserland/builder:24-wine` image. A pull request that changes packaging gets unsigned builds as workflow artifacts. A `v*` tag gets a signed, notarized macOS build and a release.

## Steps

1. Once, add these repository secrets:

   | Secret                     | Value                                                                       |
   | -------------------------- | --------------------------------------------------------------------------- |
   | `MAC_CERTIFICATE_P12`      | The Developer ID Application certificate exported as `.p12`, base64 encoded |
   | `MAC_CERTIFICATE_PASSWORD` | The `.p12` password                                                         |
   | `APPLE_API_KEY_P8`         | The contents of `AuthKey_XXXX.p8`                                           |
   | `APPLE_API_KEY_ID`         | The key id                                                                  |
   | `APPLE_API_ISSUER`         | The issuer uuid                                                             |

   The workflow's own `GITHUB_TOKEN` creates and publishes the release, since it lives in this repository.

2. Tag a commit on `main` and push the tag. The tag is the version; `package.json` is not bumped.

   ```sh
   git tag v0.2.0 origin/main && git push origin v0.2.0
   ```

   The `draft` job creates a draft release with notes generated from the pull requests merged since the previous `v*` tag. Each build job writes the tag's version into `package.json` before packaging. The build jobs upload the DMG, the macOS zip, the Windows installer, the AppImage, their blockmaps, and `latest-mac.yml`, `latest.yml` and `latest-linux.yml` into it, and the `release` job publishes it. Installers skip Actions artifact storage, so its quota cannot block a release. If a build job fails, rerun the failed jobs; the upload replaces assets already in the draft.

3. The `npm` job then publishes the same version to npm as `hinacode`, for `npx hinacode serve` (see `cloud.md`). It publishes the staged server package in `dist-npm`, never the repository root, which is private. It authenticates with npm trusted publishing, which npm only lets you configure on a package that exists. So once, by hand, from a clean checkout of the tag:

   ```sh
   npm pkg set version=0.1.0-alpha.9 && pnpm build:server && pnpm stage:server && pnpm verify:server && npm publish ./dist-npm --tag latest
   ```

   Then on npmjs.com, under the package's Settings > Trusted publishing, add GitHub Actions with this repository and the workflow `build.yml`.

For a local build without signing or publishing, run `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist -c.mac.notarize=false`. It builds for the current platform, and the output lands in `dist/`.

## If it goes wrong

- **The app quits at startup with `ERR_MODULE_NOT_FOUND`.** A main-process import pulls in a package that is not packaged. Only packages that `out/main` leaves external belong in `dependencies`; the renderer is bundled by Vite, so its packages are `devDependencies`. Import a subpath instead of a barrel (for example `@effect/platform-node/NodeHttpServer`), or move the package to `dependencies`. The server bundle leaves only the externals in `scripts/server-package.ts` external, and the staged npm manifest lists exactly those.
- **A thread says its agent is not installed.** The app ships no agent CLI. It runs the user's own `claude`, `codex` or `muse`, found with `which <name>` on the PATH that main reads from `$SHELL -ilc`, since an app opened from the Dock gets launchd's minimal PATH. The desktop starts from the PATH it saved in `<dataDir>/shell-path` and refreshes it in the background, so a CLI on a new PATH entry is found a few seconds after launch, or on the next launch. Run `$SHELL -ilc 'command -v <name>'` in a terminal; if it misses, add the CLI's directory to PATH in the shell's rc file.
- **Installed apps do not update.** Check that the release is published, not a draft, and that it has the `latest*.yml` for that platform. Squirrel.Mac also refuses a build signed with a different identity than the running app.
- **`npx hinacode serve` fails with `ERR_MODULE_NOT_FOUND` or `does not provide an export named` from `electron`.** Code that `daemon.ts` loads imported `electron`, or the bundle left a package external that the staged manifest does not list. Keep Electron in `index.ts`, `ipc.ts`, `updater.ts` and `notificationPermission.ts`, and pass what the shared code needs through `app.ts`. Run `pnpm build:server && pnpm stage:server && pnpm verify:server`. It installs the staged package away from the checkout and boots it, so a missing dependency fails there instead of on a user's server.
- **The Windows build fails in `wine`.** It needs real x64. Wine crashes under Docker's x64 emulation on Apple Silicon, so build Windows in CI.
