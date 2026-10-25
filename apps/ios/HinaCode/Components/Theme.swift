import HinaCodeKit
import SwiftUI

extension Color {
    /// A color with its own value in dark mode, for the few brand and syntax colors the system palette lacks.
    nonisolated init(light: UInt32, dark: UInt32) {
        self.init(
            uiColor: UIColor { traits in
                UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
            })
    }
}

extension UIColor {
    nonisolated fileprivate convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// GitHub's light and dark syntax colors. Plain text keeps the text color. Nonisolated, so code is colored off the
/// main actor.
nonisolated enum SyntaxPalette {
    private static let comment = Color(light: 0x57606A, dark: 0x8B949E)
    private static let string = Color(light: 0x0A3069, dark: 0xA5D6FF)
    private static let number = Color(light: 0x0550AE, dark: 0x79C0FF)
    private static let keyword = Color(light: 0xCF222E, dark: 0xFF7B72)
    private static let type = Color(light: 0x953800, dark: 0xFFA657)
    private static let function = Color(light: 0x6639BA, dark: 0xD2A8FF)

    static func color(_ kind: SyntaxToken.Kind) -> Color? {
        switch kind {
        case .plain: nil
        case .comment: comment
        case .string: string
        case .number, .constant: number
        case .keyword, .operator: keyword
        case .type: type
        case .function: function
        }
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

extension IndicatorTone {
    var color: Color {
        switch self {
        case .muted: .secondary
        case .attention: Tone.attention.color
        case .success: Tone.running.color
        case .danger: Tone.danger.color
        case .prOpen: .green
        case .prMerged: .purple
        }
    }
}

/// How long ago a timestamp was, in the sidebar's short form. Rows wrap it in a `TimelineView` to refresh.
struct RelativeTimeText: View {
    let iso: String
    let now: Date

    var body: some View {
        Text(Self.label(RelativeTime(since: iso, now: now)))
            .monospacedDigit()
    }

    static func label(_ time: RelativeTime) -> LocalizedStringResource {
        switch time {
        case .now: .mobileTimeNow
        case .minutes(let count): .mobileTimeMinutes(String(count))
        case .hours(let count): .mobileTimeHours(String(count))
        case .days(let count): .mobileTimeDays(String(count))
        case .weeks(let count): .mobileTimeWeeks(String(count))
        case .months(let count): .mobileTimeMonths(String(count))
        case .years(let count): .mobileTimeYears(String(count))
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
