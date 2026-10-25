import HinaCodeKit
import SwiftUI

@main
struct HinaCodeApp: App {
    @State private var model: AppModel
    @State private var router: Router
    @State private var notifier: Notifier
    @Environment(\.scenePhase) private var scenePhase

    init() {
        #if DEBUG
            if UserDefaults.standard.bool(forKey: "HinaCodeResetState") { Self.resetState() }
        #endif
        let model = AppModel(hub: ServerHub())
        let router = Router()
        _model = State(initialValue: model)
        _router = State(initialValue: router)
        _notifier = State(initialValue: Notifier(model: model, router: router))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(router)
                .preferredColorScheme(colorScheme)
                .task { model.start() }
                .onOpenURL { model.open($0) }
                .onChange(of: scenePhase) { _, phase in
                    model.setActive(phase == .active)
                    notifier.appActive = phase == .active
                }
                .task(id: model.hub.paired) {
                    if model.hub.paired { await notifier.requestAuthorizationIfUndetermined() }
                }
        }

        // One thread in its own window, from a row's context menu on iPad.
        WindowGroup(for: String.self) { binding in
            if let threadId = binding.wrappedValue {
                ThreadWindow(threadId: threadId)
                    .environment(model)
                    .preferredColorScheme(colorScheme)
                    .task { model.start() }
            }
        }
    }

    private var colorScheme: ColorScheme? {
        switch model.preferences.appearance {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// Back to a first launch, so a UI test run starts unpaired.
    private static func resetState() {
        let storage = KeychainServerStorage()
        storage.saveServers([])
        storage.saveRelayAccount(nil)
        if let domain = Bundle.main.bundleIdentifier {
            UserDefaults.standard.removePersistentDomain(forName: domain)
        }
    }
}

/// A thread opened in its own window: the thread with its own navigation stack, sharing the app's model.
private struct ThreadWindow: View {
    let threadId: String

    @Environment(AppModel.self) private var model
    @State private var router = Router()

    var body: some View {
        NavigationStack(path: Bindable(router).path) {
            ThreadView(threadId: threadId)
                .navigationDestination(for: DetailRoute.self) { DetailDestination(route: $0) }
        }
        .environment(router)
        .onAppear {
            router.selection = .thread(threadId)
            model.unseen.clear(threadId: threadId)
        }
    }
}
