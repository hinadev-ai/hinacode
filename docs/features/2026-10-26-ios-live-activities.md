# Live Activities and a threads widget on iOS

Status: Building
Date: 2026-10-26

## Problem

A developer sends a prompt from the phone, then locks it. To learn whether the agent finished, failed or is waiting on an approval, they have to unlock the phone and open the app. A notification arrives only for the end of the turn, and only while the app is still alive. Nothing on the Home Screen says which threads need them.

## User flow

1. The developer sends or steers a prompt from the composer. A Live Activity for that thread appears on the Lock Screen and in the Dynamic Island: the thread's title, its agent, a running clock, and the step the agent is on ("Bash pnpm test").
2. When the agent asks for an approval or a question, the activity turns orange and says what it asks. When the turn ends, it says Done or Failed and the clock stops.
3. Tapping the activity opens the thread.
4. A Home Screen or Lock Screen widget shows how many threads need the developer and how many are working, with the most urgent threads listed. Tapping a thread opens it.

## Design

- `ThreadActivityAttributes` and `ThreadActivityState` live in HinaCodeKit, so the app and the widget extension share one definition. The state is plain Codable JSON (`phase`, `startedAt`, `endedAt`, `detail`), the shape an ActivityKit push carries as `content-state`, so a push path can send it later without a new type.
- `ThreadActivityState.applying(_:at:queued:)` is a pure reducer from `AgentEvent` to the next state, and `reconciled(with:)` corrects the phase from a thread's status after a reload. Events that change nothing return the state unchanged, so the controller updates only on a real change.
- `LiveActivities` in the app starts an activity after a send or steer succeeds, listens on `PushListeners` for that thread's events, ends the activity when the turn ends, and reconciles every activity after each handshake. One activity per thread: starting a new turn ends the previous one at once.
- While the app is suspended nothing can update an activity. Each update sets a `staleDate` three minutes out, and a heartbeat moves it forward while the thread's server is connected. A stale activity says so ("Open HinaCode for the latest") instead of showing a state that may be wrong.
- `WidgetSnapshot` in HinaCodeKit is the widget's whole input: when it was taken, and up to six threads that need attention, failed, finished unseen, or are working. The app encodes it into the App Group `group.app.hinacode.ios` whenever threads or unseen marks change, and asks WidgetKit to reload. The widget never talks to a desktop.
- `hinacode://thread?id=<id>` opens a thread. The activity and the widget use it.
- `HinaCodeWidgets` is a widget extension target. It compiles the app's `Theme.swift`, `Assets.xcassets` and `Localizable.xcstrings` through target membership, so marks, colors and copy have one source.

## Out of scope

- Updates while the app is suspended. They need ActivityKit push tokens sent to the relay and APNs delivery from it. The state's Codable shape is ready for that.
- Approving from the Lock Screen. A `LiveActivityIntent` would have to reconnect a socket from the background.
- Activities for turns started on the desktop.

## Verification

- `swift test --package-path apps/ios/HinaCodeKit` covers the reducer, the reconciliation, the snapshot's selection and order, and the link parser.
- In the simulator, against `hinacode serve` with `HINACODE_MOCK_CLAUDE=approvals`: send a prompt, go home and lock, and screenshot the Dynamic Island and the Lock Screen while it waits on an approval and after it finishes. Add the widget to the Home Screen and screenshot it.
