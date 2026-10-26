import SwiftTerm
import UIKit

/// SwiftTerm's view on system colors and Dynamic Type, with Command-K to clear as in Terminal.app. Its input accessory
/// bar has the keys a software keyboard lacks: Esc, Ctrl, Tab and the arrows.
final class ShellTerminalView: TerminalView {
    private var reportedSize = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        changeScrollback(5000)
        accessibilityLabel = String(localized: .mobileThreadTabTerminal)
        accessibilityIdentifier = "terminal-view"
        applyColors()
        applyFont()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) {
            (view: ShellTerminalView, _) in view.applyColors()
        }
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (view: ShellTerminalView, _) in
            view.applyFont()
        }
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // SwiftTerm reports a size only when it differs from the one it starts with, so the first is reported here.
        guard !reportedSize, !bounds.isEmpty else { return }
        reportedSize = true
        let size = terminalDimensions
        terminalDelegate?.sizeChanged(source: self, newCols: size.cols, newRows: size.rows)
    }

    override var keyCommands: [UIKeyCommand]? {
        let clear = UIKeyCommand(
            title: String(localized: .mobileTerminalClear), action: #selector(clearToPrompt), input: "k",
            modifierFlags: .command)
        return (super.keyCommands ?? []) + [clear]
    }

    /// Drops the scrollback and scrolls the cursor's line to the top. Full-screen programs keep their screen.
    @objc private func clearToPrompt() {
        guard terminalInputStateSnapshot()?.isAlternateBuffer == false else { return }
        let row = terminalStateSnapshot().cursor.row
        feed(text: (row > 0 ? "\u{1b}[\(row)S\u{1b}[\(row)A" : "") + "\u{1b}[3J")
    }

    private func applyColors() {
        let foreground = UIColor(resource: .Palette.foreground).resolvedColor(with: traitCollection)
        let accent = UIColor(resource: .accent).resolvedColor(with: traitCollection)
        nativeForegroundColor = foreground
        nativeBackgroundColor = UIColor(resource: .Palette.background).resolvedColor(with: traitCollection)
        caretColor = accent
        selectedTextBackgroundColor = accent.withAlphaComponent(0.3)
        selectedTextForegroundColor = foreground
        // Programs pick colors for a background they cannot see, so text is kept readable on either one.
        minimumContrastRatio = traitCollection.accessibilityContrast == .high ? 7 : 4.5
        installColors(Self.palette(for: traitCollection))
    }

    private func applyFont() {
        let base = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        font = UIFontMetrics(forTextStyle: .body).scaledFont(
            for: base, maximumPointSize: 26, compatibleWith: traitCollection)
    }

    /// The 16 ANSI colors from the system palette, which has its own values for dark mode and Increase Contrast.
    /// The bright hues are the system's dark mode ones, which are lighter.
    private static func palette(for traits: UITraitCollection) -> [SwiftTerm.Color] {
        let lighter = traits.modifyingTraits { $0.userInterfaceStyle = .dark }
        let hues: [UIColor] = [.systemRed, .systemGreen, .systemYellow, .systemBlue, .systemPurple, .systemCyan]
        let normal = [UIColor.black] + hues.map { $0.resolvedColor(with: traits) } + [.lightGray]
        let bright = [UIColor.systemGray.resolvedColor(with: traits)] + hues.map { $0.resolvedColor(with: lighter) }
        return (normal + bright + [.white]).map(\.terminalColor)
    }
}

extension UIColor {
    fileprivate var terminalColor: SwiftTerm.Color {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        func channel(_ value: CGFloat) -> UInt16 { UInt16(min(max(value, 0), 1) * 65535) }
        return SwiftTerm.Color(red: channel(red), green: channel(green), blue: channel(blue))
    }
}
