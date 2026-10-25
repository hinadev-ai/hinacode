# 0023. The iOS app is native SwiftUI, Android stays on Expo

Status: Accepted
Date: 2026-10-25

## Context

One Expo app served iPhone, iPad and Android. iOS 26 brought Liquid Glass and a set of system surfaces (split view, sheets with detents, search, toolbars that blur the content under them) that React Native can only imitate. The iPad layout was already a hand-built `NavigationSplitView`, and the phone could not read hardware keyboard modifiers. The protocol the phone speaks is small, typed in `src/shared`, and well tested, so a second client is a port, not a redesign.

## Decision

iPhone and iPad get a native SwiftUI app in `apps/ios`, with its non-view code in the `HinaCodeKit` Swift package. Its wire types are generated from the Effect schemas by `scripts/swift-contract.ts`, and its copy from `messages/*.json` by `scripts/ios-strings.ts`. Android keeps the Expo app in `apps/mobile`.

## Consequences

- iOS gets system UI and behavior for free and keeps getting it with each release.
- Two phone clients to maintain. The transport, hub and stores are line-by-line ports with the same tests, so a protocol change lands in both by porting the diff and its test.
- The contract cannot drift silently: a renamed field fails the Swift build after `swift-contract.ts` runs, and CI fails when the generated file is stale.
- A new method or push the iOS app uses has to be added to the lists in `swift-contract.ts`.
- Revisit if the Expo app's Android-only code starts diverging in ways that need their own design, or if a shared Swift-on-Android path becomes practical.
