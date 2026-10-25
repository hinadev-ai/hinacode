import SwiftUI

/// Placeholder for a pull request's page, built by the browse unit.
struct PullRequestView: View {
    let threadId: String
    let url: String

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(verbatim: url)
            } icon: {
                Image(systemName: "arrow.triangle.branch")
            }
        }
    }
}
