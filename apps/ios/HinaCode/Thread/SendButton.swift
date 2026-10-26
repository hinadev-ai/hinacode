import SwiftUI

/// The composer's send button face, as the desktop's: 32 points, the holographic halo while there is something to
/// send or stop, and a quiet disc otherwise.
struct SendButtonLabel: View {
    let symbol: String
    let active: Bool

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: symbol == "stop.fill" ? 12 : 15, weight: .semibold))
            .foregroundStyle(active ? Palette.primaryForeground : Palette.mutedForeground)
            .contentTransition(.symbolEffect(.replace))
            .frame(width: 32, height: 32)
            .background {
                if active {
                    SendHalo()
                        .transition(.opacity)
                } else {
                    Circle()
                        .fill(Palette.foreground.opacity(0.06))
                        .strokeBorder(Palette.border, lineWidth: 1)
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.15), value: active)
            .frame(width: 44, height: 44)
            .contentShape(.circle)
    }
}

/// The desktop's `send-halo`: a conic gradient of the primary turned +45° and -35° in hue, a calm core so the glyph
/// sits on one color, and a layer of grain. It turns while it shows, and holds still under Reduce Motion.
struct SendHalo: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let turn: TimeInterval = 6

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let elapsed = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.turn)
            let angle = elapsed / Self.turn * 360
            GeometryReader { proxy in
                let radius = proxy.size.width / 2
                ZStack {
                    AngularGradient(
                        colors: [Palette.primary, Palette.sendB, Palette.sendC, Palette.primary, Palette.primary],
                        center: .center, angle: .degrees(reduceMotion ? 0 : angle))
                    RadialGradient(
                        stops: [
                            .init(color: Palette.primary.opacity(0.7), location: 0),
                            .init(color: Palette.primary.opacity(0.7), location: 0.35),
                            .init(color: Palette.primary.opacity(0), location: 0.7),
                        ],
                        center: .center, startRadius: 0, endRadius: radius * 2.squareRoot())
                    Image(.sendGrain)
                        .resizable()
                        .blendMode(.overlay)
                        .opacity(0.55)
                }
            }
        }
        .clipShape(.circle)
        .overlay { Circle().strokeBorder(.white.opacity(0.18), lineWidth: 1) }
        .accessibilityHidden(true)
    }
}

/// Press feedback as the desktop's: a slight scale down.
struct ComposerSendStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .animation(.spring(duration: 0.15, bounce: 0), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == ComposerSendStyle {
    static var composerSend: ComposerSendStyle { ComposerSendStyle() }
}
