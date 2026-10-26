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

/// The desktop's two themes from `src/renderer/index.css`: Catppuccin Latte in light mode and Tokyo Night in dark
/// mode. The values live in the asset catalog's Palette folder, with the primary as the accent color. Attention and
/// success keep the desktop's own values, since neither theme sets them there.
enum Palette {
    /// Behind grouped lists and the sidebar, the desktop's `--surface`.
    static let page = Color(.Palette.page)
    /// Plain screens, list rows and cards.
    static let background = Color(.Palette.background)
    static let muted = Color(.Palette.muted)
    static let foreground = Color(.Palette.foreground)
    static let mutedForeground = Color(.Palette.mutedForeground)
    static let border = Color(.Palette.border)
    static let input = Color(.Palette.input)
    static let primary = Color(.accent)
    static let primaryForeground = Color(.Palette.primaryForeground)
    static let ring = Color(.Palette.ring)
    static let destructive = Color(.Palette.destructive)
    static let attention = Color(.Palette.attention)
    static let success = Color(.Palette.success)
    /// The send halo's second and third stops: the primary turned +45° and -35° in hue, as the desktop derives them.
    static let sendB = Color(.Palette.sendB)
    static let sendC = Color(.Palette.sendC)
}

extension View {
    /// A list or form on the palette: the page behind it, and its rows on `Palette.background`.
    func paletteList() -> some View {
        scrollContentBackground(.hidden)
            .background(Palette.page)
    }
}

/// The tones a status, notice or mark can take, on the palette.
enum Tone {
    case neutral, attention, running, danger

    var color: Color {
        switch self {
        case .neutral: Palette.mutedForeground
        case .attention: Palette.attention
        case .running: Palette.success
        case .danger: Palette.destructive
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
    @ScaledMetric private var size: CGFloat

    init(provider: ProviderId, size: CGFloat = 16) {
        self.provider = provider
        _size = ScaledMetric(wrappedValue: size, relativeTo: .body)
    }

    var body: some View {
        provider.mark
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(provider.brand)
            .accessibilityLabel(Text(provider.name))
    }
}
