import SwiftUI

/// Placeholder for the files panel, built by the files unit. Deleted when the real panel lands.
struct FilesPanel: View {
    let threadId: String

    var body: some View {
        ContentUnavailableView(.mobileThreadTabFiles, systemImage: "folder")
    }
}
