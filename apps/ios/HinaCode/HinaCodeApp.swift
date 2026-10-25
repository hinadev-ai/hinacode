import HinaCodeKit
import SwiftUI

@main
struct HinaCodeApp: App {
    var body: some Scene {
        WindowGroup {
            VStack {
                Text(.mobileHomeTitle)
                Text(.mobileTerminalReattachFailed("boom"))
                Text(RPC.threadsList.name)
            }
            .padding()
            .glassEffect()
        }
    }
}
