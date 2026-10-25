import HinaCodeKit
import SwiftUI

/// Placeholder for the thread screen (chat, files, pull requests, terminal), built by the thread unit.
struct ThreadView: View {
    let threadId: String

    @Environment(AppModel.self) private var model

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(verbatim: model.threads.threads[threadId]?.title ?? "")
            } icon: {
                Image(systemName: "text.bubble")
            }
        }
    }
}
