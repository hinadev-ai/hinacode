import SwiftUI

/// Placeholder for a folder in a thread's workspace, built by the browse unit.
struct FolderView: View {
    let threadId: String
    let path: String

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(verbatim: path)
            } icon: {
                Image(systemName: "folder")
            }
        }
    }
}
