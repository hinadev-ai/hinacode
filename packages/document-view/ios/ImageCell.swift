import UIKit

enum ImageState {
  case loading
  case loaded(UIImage)
  case failed
}

final class ImageCell: BlockCell {
  private static let placeholderHeight: CGFloat = 120
  private static let maxHeight: CGFloat = 480
  private let imageView = UIImageView()
  private let alt = UILabel()
  private var state = ImageState.loading

  override init(frame: CGRect) {
    super.init(frame: frame)
    imageView.contentMode = .scaleAspectFit
    imageView.layer.cornerRadius = 6
    imageView.clipsToBounds = true
    alt.numberOfLines = 0
    alt.textAlignment = .center
    alt.font = .italicSystemFont(ofSize: 14)
    contentView.addSubview(imageView)
    contentView.addSubview(alt)
  }

  required init?(coder: NSCoder) { nil }

  func configure(_ block: Block, placement: Placement, style: DocumentStyle, alt text: String, state: ImageState) {
    super.configure(block, placement: placement, style: style)
    self.state = state
    alt.textColor = style.muted
    alt.text = text.isEmpty ? nil : text
    switch state {
    case .loaded(let image):
      imageView.image = image
      imageView.backgroundColor = .clear
      alt.isHidden = true
    case .loading:
      imageView.image = nil
      imageView.backgroundColor = style.surface
      alt.isHidden = false
      alt.textAlignment = .center
    case .failed:
      imageView.image = nil
      imageView.backgroundColor = .clear
      alt.isHidden = false
      alt.textAlignment = .natural
    }
  }

  private func imageSize(width: CGFloat) -> CGSize {
    guard case .loaded(let image) = state, image.size.width > 0 else { return .zero }
    let fitted = min(width, image.size.width)
    let height = min(Self.maxHeight, fitted * image.size.height / image.size.width)
    return CGSize(width: height * image.size.width / image.size.height, height: height)
  }

  override func contentHeight(width: CGFloat) -> CGFloat {
    switch state {
    case .loaded: return imageSize(width: width).height
    case .loading: return Self.placeholderHeight
    case .failed: return ceil(alt.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    }
  }

  override func layoutContent(in frame: CGRect) {
    switch state {
    case .loaded:
      let size = imageSize(width: frame.width)
      imageView.frame = CGRect(origin: frame.origin, size: size)
    case .loading:
      imageView.frame = frame
      alt.frame = frame.insetBy(dx: 12, dy: 12)
    case .failed:
      imageView.frame = .zero
      alt.frame = frame
    }
  }
}

final class RuleCell: BlockCell {
  private let line = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(line)
  }

  required init?(coder: NSCoder) { nil }

  override func configure(_ block: Block, placement: Placement, style: DocumentStyle) {
    super.configure(block, placement: placement, style: style)
    line.backgroundColor = style.border
  }

  override func contentHeight(width: CGFloat) -> CGFloat { 9 }

  override func layoutContent(in frame: CGRect) {
    let hairline = 1 / (window?.screen.scale ?? UIScreen.main.scale)
    line.frame = CGRect(x: frame.minX, y: frame.midY, width: frame.width, height: hairline)
  }
}
