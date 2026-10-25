import HinaCodeKit
import SwiftUI

extension Color {
    /// A color with its own value in dark mode, for the few brand and syntax colors the system palette lacks.
    init(light: UInt32, dark: UInt32) {
        self.init(
            uiColor: UIColor { traits in
                UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
            })
    }
}

extension UIColor {
    fileprivate convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// The tones a status, notice or mark can take, on system colors so they follow dark mode and Increase Contrast.
enum Tone {
    case neutral, attention, running, danger

    var color: Color {
        switch self {
        case .neutral: .secondary
        case .attention: .orange
        case .running: .green
        case .danger: .red
        }
    }
}

extension ProviderId {
    var name: LocalizedStringResource {
        switch self {
        case .claude: .mobileProviderClaude
        case .codex: .mobileProviderCodex
        case .muse: .mobileProviderMuse
        case .unknown(let id): LocalizedStringResource(stringLiteral: id)
        }
    }

    var mark: Image {
        switch self {
        case .claude: Image(.Providers.claude)
        case .codex: Image(.Providers.codex)
        case .muse: Image(.Providers.muse)
        case .unknown: Image(systemName: "cpu")
        }
    }

    /// The vendors' brand colors. Codex has none, so it takes the text color.
    var brand: Color {
        switch self {
        case .claude: Color(light: 0xC15F3C, dark: 0xD97757)
        case .codex, .unknown: .primary
        case .muse: Color(light: 0x0064E0, dark: 0x0081FB)
        }
    }
}

/// The logo of the agent a thread runs, in its brand color, sized with the text around it.
struct ProviderMark: View {
    let provider: ProviderId
    @ScaledMetric(relativeTo: .body) private var size = 16

    var body: some View {
        provider.mark
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(provider.brand)
            .accessibilityLabel(Text(provider.name))
    }
}
