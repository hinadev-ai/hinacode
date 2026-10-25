import SwiftUI

/// Placeholder for the pull requests panel, built by the pull requests unit. Deleted when the real panel lands.
struct PullRequestsPanel: View {
    let threadId: String

    var body: some View {
        ContentUnavailableView(.mobileThreadTabPrs, systemImage: "arrow.triangle.pull")
    }
}
