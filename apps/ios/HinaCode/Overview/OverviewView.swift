import SwiftUI

/// Placeholder for the overview (pull requests that need you, Linear issues), built by the browse unit.
struct OverviewView: View {
    var body: some View {
        ContentUnavailableView(.mobileHomeOverview, systemImage: "square.grid.2x2")
            .navigationTitle(.mobileHomeOverview)
    }
}
