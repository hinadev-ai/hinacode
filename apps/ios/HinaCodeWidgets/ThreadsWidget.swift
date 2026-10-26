import HinaCodeKit
import SwiftUI
import WidgetKit

/// How many threads need the developer and how many are working, with the most urgent ones listed. It reads only
/// the snapshot the app leaves in the App Group.
struct ThreadsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "threads", provider: SnapshotProvider()) { entry in
            ThreadsWidgetView(snapshot: entry.snapshot)
        }
        .configurationDisplayName(Text(.mobileWidgetName))
        .description(Text(.mobileWidgetDescription))
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

struct SnapshotEntry: TimelineEntry {
    let date: Date
    /// Nil until the app has paired and listed threads.
    let snapshot: WidgetSnapshot?
}

/// The app reloads the timeline whenever its snapshot changes, so one entry is enough.
struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(date: .now, snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: .now, snapshot: Self.stored()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        completion(Timeline(entries: [SnapshotEntry(date: .now, snapshot: Self.stored())], policy: .never))
    }

    private static func stored() -> WidgetSnapshot? {
        guard let data = UserDefaults(suiteName: WidgetSnapshot.appGroup)?.data(forKey: WidgetSnapshot.defaultsKey)
        else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}

extension WidgetSnapshot {
    /// Row shapes for the redacted placeholder. Its text never shows.
    fileprivate static var placeholder: WidgetSnapshot {
        let states: [State] = [.needsYou, .working, .finished]
        let threads = states.enumerated().map { index, state in
            Thread(
                id: "\(index)", title: String(localized: .mobileHomeUntitled), provider: .claude, project: "HinaCode",
                state: state, updatedAt: .now)
        }
        return WidgetSnapshot(takenAt: .now, threads: threads, needsYou: 1, working: 1)
    }
}

extension WidgetSnapshot.State {
    var symbol: String {
        switch self {
        case .needsYou: "questionmark.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        case .finished: "checkmark.circle.fill"
        case .working: "waveform.path.ecg"
        }
    }

    var color: Color {
        switch self {
        case .needsYou: Tone.attention.color
        case .failed: Tone.danger.color
        case .finished: Tone.running.color
        case .working: .secondary
        }
    }

    var name: LocalizedStringResource {
        switch self {
        case .needsYou: .mobileStatusAwaiting
        case .failed: .mobileActivityFailed
        case .finished: .mobileActivityFinished
        case .working: .mobileStatusRunning
        }
    }

    /// "Needs you: 2" or "Running: 2", for the two states the widget counts.
    func counted(_ count: Int) -> LocalizedStringResource {
        self == .needsYou ? .mobileWidgetNeedsYouCount(String(count)) : .mobileWidgetRunningCount(String(count))
    }
}

struct ThreadsWidgetView: View {
    let snapshot: WidgetSnapshot?
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            .widgetURL(snapshot?.threads.first.map { ThreadLink.url(threadId: $0.id) })
            .containerBackground(for: .widget) {
                if family == .accessoryCircular { AccessoryWidgetBackground() }
            }
    }

    @ViewBuilder private var content: some View {
        switch (family, snapshot) {
        case (.accessoryInline, _): InlineView(snapshot: snapshot)
        case (.accessoryCircular, _): CircularView(snapshot: snapshot)
        case (.accessoryRectangular, _): RectangularView(snapshot: snapshot)
        case (_, nil): UnpairedView()
        case (.systemMedium, let snapshot?): MediumView(snapshot: snapshot)
        case (_, let snapshot?): SmallView(snapshot: snapshot)
        }
    }
}

// MARK: - Home Screen

private struct SmallView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        if let top = snapshot.threads.first {
            VStack(alignment: .leading, spacing: 0) {
                Text(snapshot.needsYou, format: .number)
                    .font(.largeTitle.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(snapshot.needsYou > 0 ? Tone.attention.color : .primary)
                    .widgetAccentable()
                    .accessibilityLabel(Text(WidgetSnapshot.State.needsYou.counted(snapshot.needsYou)))
                Text(.mobileStatusAwaiting)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Spacer(minLength: 8)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    StateSymbol(state: top.state)
                    Text(verbatim: top.displayTitle)
                        .lineLimit(2)
                }
                .font(.footnote.weight(.semibold))
                .accessibilityElement(children: .combine)
                TakenAt(date: snapshot.takenAt)
                    .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        } else {
            NothingView(takenAt: snapshot.takenAt)
        }
    }
}

private struct MediumView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        if snapshot.threads.isEmpty {
            NothingView(takenAt: snapshot.takenAt)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    Count(state: .needsYou, count: snapshot.needsYou)
                    Count(state: .working, count: snapshot.working)
                }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(snapshot.threads.prefix(3)) { thread in
                        Link(destination: ThreadLink.url(threadId: thread.id)) {
                            Row(thread: thread)
                        }
                    }
                }
                Spacer(minLength: 0)
                TakenAt(date: snapshot.takenAt)
            }
        }
    }
}

/// A count in the medium header: the state's symbol, the number, and what it counts.
private struct Count: View {
    let state: WidgetSnapshot.State
    let count: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            StateSymbol(state: state)
                .accessibilityHidden(true)
            Text(count, format: .number)
                .font(.headline)
                .monospacedDigit()
                .widgetAccentable()
            Text(state.name)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(state.counted(count)))
    }
}

private struct Row: View {
    let thread: WidgetSnapshot.Thread

    var body: some View {
        HStack(spacing: 8) {
            ProviderMark(provider: thread.provider)
            Text(verbatim: thread.displayTitle)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
                .layoutPriority(1)
            Spacer(minLength: 0)
            if !thread.project.isEmpty {
                Text(verbatim: thread.project)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            StateSymbol(state: thread.state)
                .font(.subheadline)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct NothingView: View {
    let takenAt: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: WidgetSnapshot.State.finished.symbol)
                .font(.title2)
                .foregroundStyle(WidgetSnapshot.State.finished.color)
                .widgetAccentable()
                .accessibilityHidden(true)
            Spacer(minLength: 0)
            Text(.mobileWidgetNothing)
                .font(.headline)
            TakenAt(date: takenAt)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct UnpairedView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: "macbook.and.iphone")
                .font(.title2)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Spacer(minLength: 0)
            Text(.mobileWidgetUnpaired)
                .font(.headline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - Lock Screen

/// The one count an accessory family has room for: what needs the developer, else what is working.
private struct Headline {
    let state: WidgetSnapshot.State
    let count: Int

    init?(_ snapshot: WidgetSnapshot) {
        if snapshot.needsYou > 0 {
            (state, count) = (.needsYou, snapshot.needsYou)
        } else if snapshot.working > 0 {
            (state, count) = (.working, snapshot.working)
        } else {
            return nil
        }
    }

    var label: LocalizedStringResource { state.counted(count) }
}

private struct InlineView: View {
    let snapshot: WidgetSnapshot?

    var body: some View {
        if let snapshot {
            if let headline = Headline(snapshot) {
                Label {
                    Text(headline.label)
                } icon: {
                    Image(systemName: headline.state.symbol)
                }
            } else {
                Label {
                    Text(.mobileWidgetNothing)
                } icon: {
                    Image(systemName: WidgetSnapshot.State.finished.symbol)
                }
            }
        } else {
            Label {
                Text(.mobileWidgetUnpaired)
            } icon: {
                Image(systemName: "macbook.and.iphone")
            }
        }
    }
}

private struct CircularView: View {
    let snapshot: WidgetSnapshot?

    var body: some View {
        Group {
            if let snapshot, let headline = Headline(snapshot) {
                VStack(spacing: 0) {
                    Image(systemName: headline.state.symbol)
                        .font(.body)
                    Text(headline.count, format: .number)
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                        .minimumScaleFactor(0.6)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(headline.label))
            } else if snapshot != nil {
                Image(systemName: WidgetSnapshot.State.finished.symbol)
                    .font(.title)
                    .accessibilityLabel(Text(.mobileWidgetNothing))
            } else {
                Image(systemName: "macbook.and.iphone")
                    .font(.title3)
                    .accessibilityLabel(Text(.mobileWidgetUnpaired))
            }
        }
        .widgetAccentable()
    }
}

private struct RectangularView: View {
    let snapshot: WidgetSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let snapshot, !snapshot.threads.isEmpty {
                HStack(spacing: 10) {
                    LockCount(state: .needsYou, count: snapshot.needsYou)
                    LockCount(state: .working, count: snapshot.working)
                }
                .font(.headline)
                .widgetAccentable()
                ForEach(snapshot.threads.prefix(2)) { thread in
                    HStack(spacing: 4) {
                        Image(systemName: thread.state.symbol)
                            .imageScale(.small)
                            .accessibilityLabel(Text(thread.state.name))
                        Text(verbatim: thread.displayTitle)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                }
            } else {
                Label {
                    Text(snapshot == nil ? .mobileWidgetUnpaired : .mobileWidgetNothing)
                } icon: {
                    Image(systemName: snapshot == nil ? "macbook.and.iphone" : WidgetSnapshot.State.finished.symbol)
                }
                .font(.headline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct LockCount: View {
    let state: WidgetSnapshot.State
    let count: Int

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: state.symbol)
            Text(count, format: .number)
                .monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(state.counted(count)))
    }
}

// MARK: - Parts

private struct StateSymbol: View {
    let state: WidgetSnapshot.State

    var body: some View {
        Image(systemName: state.symbol)
            .foregroundStyle(state.color)
            .widgetAccentable()
            .accessibilityLabel(Text(state.name))
    }
}

/// How old the snapshot is, kept current by the system without a timeline entry per minute.
private struct TakenAt: View {
    let date: Date

    var body: some View {
        Text(.currentDate, format: .reference(to: date, allowedFields: [.minute, .hour, .day], maxFieldCount: 1))
            .font(.caption2)
            .foregroundStyle(.secondary)
            .monospacedDigit()
    }
}

extension WidgetSnapshot.Thread {
    fileprivate var displayTitle: String {
        title.isEmpty ? String(localized: .mobileHomeUntitled) : title
    }
}
