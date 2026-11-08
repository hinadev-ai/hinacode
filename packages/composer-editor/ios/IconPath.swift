import UIKit

/**
 Parses the SVG path data of an `@hinacode/icons` shape. The set's rules allow only circle arcs, so `A` takes one
 radius; everything else (`M L H V C Q Z`, absolute and relative) follows SVG.
 */
enum IconPath {
  static func parse(_ data: String) -> UIBezierPath {
    let path = UIBezierPath()
    var tokens = tokenize(data)[...]
    var command: Character = "M"
    var current = CGPoint.zero
    var start = CGPoint.zero

    func number() -> CGFloat {
      guard case let .number(value)? = tokens.popFirst() else { return 0 }
      return value
    }
    func point(relative: Bool) -> CGPoint {
      let x = number(), y = number()
      return relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
    }

    while let token = tokens.first {
      if case let .command(next) = token {
        command = next
        tokens.removeFirst()
      }
      let relative = command.isLowercase
      switch command.uppercased() {
      case "M":
        current = point(relative: relative)
        start = current
        path.move(to: current)
        command = relative ? "l" : "L"
      case "L":
        current = point(relative: relative)
        path.addLine(to: current)
      case "H":
        let x = number()
        current.x = relative ? current.x + x : x
        path.addLine(to: current)
      case "V":
        let y = number()
        current.y = relative ? current.y + y : y
        path.addLine(to: current)
      case "C":
        let first = point(relative: relative), second = point(relative: relative), end = point(relative: relative)
        path.addCurve(to: end, controlPoint1: first, controlPoint2: second)
        current = end
      case "Q":
        let control = point(relative: relative), end = point(relative: relative)
        path.addQuadCurve(to: end, controlPoint: control)
        current = end
      case "A":
        let radius = number()
        _ = number()
        _ = number()
        let largeArc = number() != 0
        let sweep = number() != 0
        let end = point(relative: relative)
        addArc(to: path, from: current, to: end, radius: radius, largeArc: largeArc, sweep: sweep)
        current = end
      case "Z":
        path.close()
        current = start
        if case .number? = tokens.first { tokens.removeFirst() }
      default:
        tokens.removeFirst()
      }
    }
    return path
  }

  private enum Token {
    case command(Character)
    case number(CGFloat)
  }

  private static func tokenize(_ data: String) -> [Token] {
    var tokens: [Token] = []
    var buffer = ""
    func flush() {
      if let value = Double(buffer) { tokens.append(.number(CGFloat(value))) }
      buffer = ""
    }
    for character in data {
      if character.isLetter && character != "e" {
        flush()
        tokens.append(.command(character))
      } else if character == "-" && !buffer.isEmpty && buffer.last != "e" {
        flush()
        buffer.append(character)
      } else if character == "." && buffer.contains(".") {
        flush()
        buffer.append(character)
      } else if character == "," || character.isWhitespace {
        flush()
      } else {
        buffer.append(character)
      }
    }
    flush()
    return tokens
  }

  /// SVG's endpoint arc, for a circle: find the center on the side `sweep` and `largeArc` pick, then draw from it.
  private static func addArc(
    to path: UIBezierPath, from: CGPoint, to: CGPoint, radius: CGFloat, largeArc: Bool, sweep: Bool
  ) {
    let chord = hypot(to.x - from.x, to.y - from.y)
    guard chord > 0, radius > 0 else { return }
    let r = max(radius, chord / 2)
    let middle = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
    let offset = sqrt(max(0, r * r - chord * chord / 4))
    let direction: CGFloat = largeArc == sweep ? -1 : 1
    let center = CGPoint(
      x: middle.x + direction * offset * (from.y - to.y) / chord,
      y: middle.y + direction * offset * (to.x - from.x) / chord
    )
    let startAngle = atan2(from.y - center.y, from.x - center.x)
    let endAngle = atan2(to.y - center.y, to.x - center.x)
    path.addArc(withCenter: center, radius: r, startAngle: startAngle, endAngle: endAngle, clockwise: sweep)
  }
}
