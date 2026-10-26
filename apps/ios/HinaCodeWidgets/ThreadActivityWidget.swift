import ActivityKit
import HinaCodeKit
import SwiftUI
import WidgetKit

/// A turn sent from the phone, on the Lock Screen and in the Dynamic Island. Tapping it opens the thread.
struct ThreadActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ThreadActivityAttributes.self) { context in
            LockScreenActivity(context: context)
                .widgetURL(ThreadLink.url(threadId: context.attributes.threadId))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ProviderMark(provider: context.attributes.provider, size: 22)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TurnClock(state: context.state)
                        .font(.headline)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(verbatim: context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        PhaseLabel(phase: context.state.phase)
                        StepText(state: context.state, isStale: context.isStale)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                ProviderMark(provider: context.attributes.provider)
            } compactTrailing: {
                if context.state.phase == .working {
                    TurnClock(state: context.state)
                        .frame(maxWidth: 44)
                } else {
                    PhaseSymbol(phase: context.state.phase)
                }
            } minimal: {
                PhaseSymbol(phase: context.state.phase)
            }
            .widgetURL(ThreadLink.url(threadId: context.attributes.threadId))
            .keylineTint(context.state.phase.tint)
        }
    }
}

private struct LockScreenActivity: View {
    let context: ActivityViewContext<ThreadActivityAttributes>

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProviderMark(provider: context.attributes.provider, size: 24)
                .frame(width: 40, height: 40)
                .background(.fill.tertiary, in: .circle)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(verbatim: context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    TurnClock(state: context.state)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    PhaseLabel(phase: context.state.phase)
                    if !context.attributes.project.isEmpty {
                        Text(verbatim: context.attributes.project)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .font(.subheadline)
                StepText(state: context.state, isStale: context.isStale)
            }
        }
        .padding(16)
        .activitySystemActionForegroundColor(.primary)
    }
}

/// How long the turn has run: ticking while it runs, frozen once it ends.
private struct TurnClock: View {
    let state: ThreadActivityState

    var body: some View {
        Group {
            if let endedAt = state.endedAt {
                let elapsed = Duration.seconds(endedAt.timeIntervalSince(state.startedAt))
                Text(elapsed, format: .time(pattern: .minuteSecond))
            } else {
                Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
            }
        }
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
    }
}

private struct PhaseLabel: View {
    let phase: ThreadActivityState.Phase

    var body: some View {
        Label {
            Text(phase.label)
        } icon: {
            PhaseSymbol(phase: phase)
        }
        .labelStyle(.titleAndIcon)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(phase.tint)
    }
}

private struct PhaseSymbol: View {
    let phase: ThreadActivityState.Phase

    var body: some View {
        Image(systemName: phase.symbol)
            .foregroundStyle(phase.tint)
            .accessibilityLabel(Text(phase.label))
    }
}

/// The step the agent is on, what it asks, or why it failed. A stale activity says to look in the app instead.
private struct StepText: View {
    let state: ThreadActivityState
    let isStale: Bool

    var body: some View {
        if isStale && !state.phase.isEnded {
            Text(.mobileActivityStale)
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if let detail = state.detail, !detail.isEmpty {
            Text(verbatim: detail)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}

extension ThreadActivityState.Phase {
    var label: LocalizedStringResource {
        switch self {
        case .working: .mobileStatusRunning
        case .needsYou: .mobileStatusAwaiting
        case .finished: .mobileActivityFinished
        case .failed: .mobileActivityFailed
        case .limited: .mobileStatusLimited
        }
    }

    var symbol: String {
        switch self {
        case .working: "waveform"
        case .needsYou: "hand.raised.fill"
        case .finished: "checkmark.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        case .limited: "hourglass"
        }
    }

    var tint: Color {
        switch self {
        case .working: .accentColor
        case .needsYou, .limited: Tone.attention.color
        case .finished: Tone.running.color
        case .failed: Tone.danger.color
        }
    }
}
