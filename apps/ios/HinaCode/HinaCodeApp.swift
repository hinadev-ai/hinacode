import HinaCodeKit
import SwiftUI

@main
struct HinaCodeApp: App {
    var body: some Scene {
        WindowGroup {
            Text(RPC.threadsList.name)
                .padding()
                .glassEffect()
        }
    }
}
