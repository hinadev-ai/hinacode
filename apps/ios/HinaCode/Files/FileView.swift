import SwiftUI

/// Placeholder for the file viewer, built by the browse unit.
struct FileView: View {
    let threadId: String
    let path: String
    let line: Int?

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(verbatim: path)
            } icon: {
                Image(systemName: "doc.text")
            }
        }
    }
}
