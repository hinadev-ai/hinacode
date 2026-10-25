import Foundation
import Network

/// Watches the network path and reports when its identity changes, like the Expo app's NetInfo listener. The first
/// update only reports the network the app started on, so it is skipped.
@MainActor
public final class NetworkMonitor {
    private let monitor = NWPathMonitor()
    private let onChange: @MainActor () -> Void
    private var identity: String?

    public init(onChange: @escaping @MainActor () -> Void) {
        self.onChange = onChange
        monitor.pathUpdateHandler = { [weak self] path in
            let types = [NWInterface.InterfaceType.wifi, .cellular, .wiredEthernet, .loopback, .other]
                .filter { path.usesInterfaceType($0) }
                .map { "\($0)" }
                .joined(separator: ",")
            let next = "\(path.status)|\(types)"
            let connected = path.status == .satisfied
            Task { @MainActor in self?.update(identity: next, connected: connected) }
        }
        monitor.start(queue: DispatchQueue(label: "app.hinacode.ios.network"))
    }

    deinit { monitor.cancel() }

    private func update(identity next: String, connected: Bool) {
        if let identity, next != identity, connected { onChange() }
        identity = next
    }
}
