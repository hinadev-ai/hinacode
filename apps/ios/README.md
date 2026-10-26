# HinaCode for iPhone and iPad

The native SwiftUI app for HinaCode's remote mode. Android keeps the Expo app in `apps/mobile`. See
`docs/adr/0023-native-ios-app.md` and `docs/features/2026-10-25-ios-native-app.md`.

- `HinaCode.xcodeproj` uses synchronized folders. Adding a file never touches `project.pbxproj`.
- `HinaCodeKit/` is a Swift package with everything that is not a view. It holds the wire contract, the transport,
  the server hub and the stores. It also builds for macOS, so `swift test` needs no simulator.
- `HinaCodeWidgets/` is the widget extension: the Live Activity for a turn sent from the phone, and the threads
  widget. It compiles the app's `Theme.swift`, `Assets.xcassets` and `Localizable.xcstrings` through target
  membership, and reads what the app shares in the App Group `group.app.hinacode.ios`. See
  `docs/features/2026-10-26-ios-live-activities.md`.
- Minimum iOS 26, for Liquid Glass.

## Build and test

```sh
swift test --package-path apps/ios/HinaCodeKit        # protocol, hub, stores, text helpers
cd apps/ios
xcodebuild build -project HinaCode.xcodeproj -scheme HinaCode \
  -destination 'generic/platform=iOS Simulator' -skipPackagePluginValidation
```

SwiftTerm ships a build plugin. xcodebuild will not run it until you trust it in Xcode, so command-line builds
pass `-skipPackagePluginValidation`.

## Try it against a scripted desktop

A throwaway `hinacode serve` answers turns from a fixture. The whole app works without an agent account:

```sh
pnpm build   # once, from the repo root
HINACODE_USER_DATA=/tmp/hinacode-ios HINACODE_MOCK_CLAUDE=markdown HINACODE_MOCK_LINEAR=1 \
  node out/main/daemon.js serve --port 48182 --host 127.0.0.1
```

It prints a `hinacode://connect?...` pairing URL. Install the app on a simulator with
`xcrun simctl install <udid> <path to HinaCode.app`, launch it with `xcrun simctl launch <udid> app.hinacode.ios`,
paste the URL into Pairing URL, and tap Connect. Set `HINACODE_MOCK_CLAUDE=approvals` to get approval and question
cards instead of Markdown.

The UI walk does all of this itself and screenshots every screen:

```sh
TEST_RUNNER_HINACODE_PAIRING_URL='hinacode://connect?host=127.0.0.1&port=48182&token=...' \
TEST_RUNNER_HINACODE_PROJECT_ROOT="$PWD" \
  xcodebuild test -project HinaCode.xcodeproj -scheme HinaCode \
  -destination 'platform=iOS Simulator,id=<udid>' -skipPackagePluginValidation \
  -only-testing:HinaCodeUITests/WalkTests -resultBundlePath /tmp/walk.xcresult
xcrun xcresulttool export attachments --path /tmp/walk.xcresult --output-path /tmp/walk-shots
```

Debug builds read the launch argument `-HinaCodeResetState YES`. It clears the Keychain items and `UserDefaults`
so a run starts unpaired. The walk uses it.

## Generated files

Two scripts generate files that CI checks for staleness. Never edit the outputs by hand.

- `HinaCodeKit/Sources/HinaCodeKit/Contract.swift` holds Swift wire types from the Effect schemas in `src/shared`.
  Regenerate with `node scripts/swift-contract.ts`. A method or push the app uses must be listed in that script.
- `HinaCode/Localizable.xcstrings` is the String Catalog from the `mobile_` keys of `messages/*.json`.
  Regenerate with `node scripts/ios-strings.ts`. Copy still lives only in `messages/`.
