import Foundation
import HinaCodeKit
import WidgetKit

/// Keeps the threads widget's snapshot in the App Group current, and asks WidgetKit to redraw when it changes.
/// An unpaired app leaves no snapshot, so the widget asks to pair.
@MainActor
final class WidgetSnapshots {
    private let defaults = UserDefaults(suiteName: WidgetSnapshot.appGroup)
    private var watcher: Task<Void, Never>?

    func start(model: AppModel) {
        guard watcher == nil, let defaults else { return }
        watcher = Task {
            var written = Self.rows(of: defaults.data(forKey: WidgetSnapshot.defaultsKey).flatMap(Self.decode))
            for await next in Observations({ Self.next(model) }) {
                guard case .ready(let snapshot) = next, Self.rows(of: snapshot) != written else { continue }
                written = Self.rows(of: snapshot)
                if let data = snapshot.flatMap({ try? JSONEncoder().encode($0) }) {
                    defaults.set(data, forKey: WidgetSnapshot.defaultsKey)
                } else {
                    defaults.removeObject(forKey: WidgetSnapshot.defaultsKey)
                }
                WidgetCenter.shared.reloadTimelines(ofKind: "threads")
            }
        }
    }

    /// Restamps the snapshot as the app leaves the foreground, the last moment it knew the threads, so the widget
    /// counts its age from there rather than from the last change.
    func stamp(model: AppModel) {
        guard let defaults, model.hub.status == .connected, case .ready(let snapshot?) = Self.next(model),
            let data = try? JSONEncoder().encode(snapshot)
        else { return }
        defaults.set(data, forKey: WidgetSnapshot.defaultsKey)
        WidgetCenter.shared.reloadTimelines(ofKind: "threads")
    }

    private enum Next {
        /// The first load after launch has not answered, so the stored snapshot is still the best guess.
        case loading
        case ready(WidgetSnapshot?)
    }

    private static func next(_ model: AppModel) -> Next {
        guard model.hub.paired else { return .ready(nil) }
        guard model.threads.status != .loading else { return .loading }
        return .ready(
            WidgetSnapshot(
                threads: Array(model.threads.threads.values), projects: model.threads.projects,
                unseen: model.unseen.outcomes, at: .now))
    }

    /// The snapshot without its time, so a write happens only when what the widget lists changed.
    private static func rows(of snapshot: WidgetSnapshot?) -> WidgetSnapshot? {
        var rows = snapshot
        rows?.takenAt = .distantPast
        return rows
    }

    private static func decode(_ data: Data) -> WidgetSnapshot? {
        try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}
