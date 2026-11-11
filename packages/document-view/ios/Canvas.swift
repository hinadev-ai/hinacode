import UIKit

protocol CanvasPainter: AnyObject {
  var size: CGSize { get }
  func paint(_ rect: CGRect)
}

class Canvas: UIView {
  private let lock = NSLock()
  private var current: CanvasPainter?

  var painter: CanvasPainter? {
    get { lock.withLock { current } }
    set {
      lock.withLock { current = newValue }
      setNeedsDisplay()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    contentMode = .topLeft
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ rect: CGRect) { painter?.paint(rect) }
}

private final class InstantTiledLayer: CATiledLayer {
  override class func fadeDuration() -> CFTimeInterval { 0 }
}

final class TiledCanvas: Canvas {
  override class var layerClass: AnyClass { InstantTiledLayer.self }

  override init(frame: CGRect) {
    super.init(frame: frame)
    (layer as? CATiledLayer)?.tileSize = CGSize(width: 1024, height: 1024)
  }

  required init?(coder: NSCoder) { nil }
}

/// Holds one canvas sized to its painter, and switches to a tiled layer when one backing store would be too large.
final class CanvasHost: UIView {
  private static let maxPlainPixels: CGFloat = 4_000_000
  private var canvas: Canvas?

  var painter: CanvasPainter? { canvas?.painter }

  func show(_ painter: CanvasPainter) {
    let scale = window?.screen.scale ?? UIScreen.main.scale
    let pixels = painter.size.width * painter.size.height * scale * scale
    let tiled = pixels > Self.maxPlainPixels
    if canvas == nil || (canvas is TiledCanvas) != tiled {
      canvas?.removeFromSuperview()
      let next = tiled ? TiledCanvas() : Canvas()
      addSubview(next)
      canvas = next
    }
    canvas?.frame = CGRect(origin: .zero, size: painter.size)
    canvas?.painter = painter
  }
}
