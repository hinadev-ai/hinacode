import ExpoModulesCore
import UIKit

private struct Item {
  let key: String
  let block: Block
}

final class DocumentBlocksView: ExpoView {
  let onDocumentEvent = EventDispatcher()

  private let layout = BlockListLayout()
  private let collectionView: UICollectionView
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private var style = DocumentStyle()
  private var items: [Item] = []
  private var placements: [Placement] = []
  private var keys = Set<String>()
  private var images: [String: ImageState] = [:]
  private var imageUsers: [String: Set<String>] = [:]
  private let renders = NSCache<NSString, AnyObject>()
  private var contentHeight: CGFloat = -1
  private var contentSizeObservation: NSKeyValueObservation?
  private var announcedReady = false

  required init(appContext: AppContext? = nil) {
    collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
    super.init(appContext: appContext)
    renders.countLimit = 400
    collectionView.contentInsetAdjustmentBehavior = .never
    collectionView.alwaysBounceVertical = true
    collectionView.backgroundColor = style.background
    addSubview(collectionView)
    dataSource = makeDataSource()
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    dataSource.apply(snapshot, animatingDifferences: false)
    contentSizeObservation = collectionView.observe(\.contentSize, options: [.new]) { [weak self] view, _ in
      DispatchQueue.main.async { self?.reportContentSize(view.contentSize.height) }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    collectionView.frame = bounds
  }

  // React Native forwards this through every plain UIView on each mounting transaction. The collection view recycles
  // its own cells, so walking them only costs frames while the document scrolls.
  @objc(updateClippedSubviewsWithClipRect:relativeToView:)
  func updateClippedSubviews(withClipRect clipRect: CGRect, relativeTo clipView: UIView) {}

  // Fabric sets the event emitter before it inserts the view, so the document can load while react-native-screens
  // still holds its screen out of the window behind another transition.
  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    guard superview != nil, !announcedReady else { return }
    announcedReady = true
    let capabilities: [Capability] = [.render, .charts, .images, .highlight, .diagrams]
    send(.ready, ["capabilities": capabilities.map(\.rawValue)])
  }

  func setTheme(_ json: String) {
    let object = json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
    style = DocumentStyle(json: object ?? [:])
    collectionView.backgroundColor = style.background
    renders.removeAllObjects()
    reconfigure(items.map(\.key))
  }

  func setContentInset(top: CGFloat? = nil, bottom: CGFloat? = nil) {
    var inset = collectionView.contentInset
    if let top { inset.top = top }
    if let bottom { inset.bottom = bottom }
    collectionView.contentInset = inset
    collectionView.verticalScrollIndicatorInsets = inset
  }

  func applyPatch(_ json: String) {
    let patch: BlockPatch
    do {
      patch = try BlockDecoder.patch(json)
    } catch {
      send(.error, ["message": "\(error)"])
      return
    }
    let start = min(max(0, patch.start), items.count)
    let range = start..<(start + min(max(0, patch.deleteCount), items.count - start))
    let removed = items[range]
    let previousBlocks = Dictionary(removed.map { ($0.key, $0.block) }, uniquingKeysWith: { first, _ in first })
    keys.subtract(previousBlocks.keys)
    let inserted = patch.insert.map { block -> Item in
      var key = block.id
      var copy = 2
      while keys.contains(key) {
        key = "\(block.id)#native\(copy)"
        copy += 1
      }
      keys.insert(key)
      return Item(key: key, block: block)
    }
    items.replaceSubrange(range, with: inserted)
    layout.replace(range, count: inserted.count)
    let previousPlacements = Array(placements[range])
    let insertedPlacements = inserted.indices.map { offset in
      Placement.between(start + offset > 0 ? items[start + offset - 1].block : nil, items[start + offset].block)
    }
    placements.replaceSubrange(range, with: insertedPlacements)

    var changed: [String] = []
    for (offset, item) in inserted.enumerated() {
      guard let before = previousBlocks[item.key] else { continue }
      let placementBefore = offset < previousPlacements.count ? previousPlacements[offset] : nil
      if before != item.block || placementBefore != insertedPlacements[offset] { changed.append(item.key) }
    }
    let follower = start + inserted.count
    if follower < items.count {
      let placement = Placement.between(follower > 0 ? items[follower - 1].block : nil, items[follower].block)
      if placement != placements[follower] {
        placements[follower] = placement
        changed.append(items[follower].key)
      }
    }
    for key in changed { renders.removeObject(forKey: key as NSString) }

    var snapshot = dataSource.snapshot()
    snapshot.deleteItems(removed.map(\.key))
    let insertedKeys = inserted.map(\.key)
    if follower < items.count {
      snapshot.insertItems(insertedKeys, beforeItem: items[follower].key)
    } else {
      snapshot.appendItems(insertedKeys)
    }
    let present = Set(changed).subtracting(previousBlocks.keys.filter { !keys.contains($0) })
    snapshot.reconfigureItems(changed.filter { present.contains($0) })
    dataSource.apply(snapshot, animatingDifferences: false)
  }

  func scrollToBlock(_ index: Int) {
    guard index >= 0, index < items.count else { return }
    collectionView.layoutIfNeeded()
    collectionView.scrollToItem(at: IndexPath(item: index, section: 0), at: .top, animated: false)
  }

  func provideImage(src: String, dataUrl: String) {
    guard let comma = dataUrl.firstIndex(of: ","), dataUrl.hasPrefix("data:") else {
      finishImage(src, nil)
      return
    }
    let header = dataUrl[..<comma]
    let payload = String(dataUrl[dataUrl.index(after: comma)...])
    let width = imageDecodeWidth
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let data =
        header.hasSuffix(";base64")
        ? Data(base64Encoded: payload, options: .ignoreUnknownCharacters)
        : payload.removingPercentEncoding?.data(using: .utf8)
      let image = data.flatMap { Self.decode($0, width: width) }
      DispatchQueue.main.async { self?.finishImage(src, image) }
    }
  }


  private func makeDataSource() -> UICollectionViewDiffableDataSource<Int, String> {
    let text = UICollectionView.CellRegistration<TextBlockCell, String> { [unowned self] cell, indexPath, key in
      guard let (item, placement) = model(key, indexPath) else { return }
      cell.configure(
        item.block, placement: placement, style: style, text: attributedText(item),
        onLink: { [weak self] href in self?.send(.linkPress, ["href": href]) })
    }
    let code = UICollectionView.CellRegistration<CodeBlockCell, String> { [unowned self] cell, indexPath, key in
      guard let (item, placement) = model(key, indexPath) else { return }
      switch item.block.body {
      case .code(let language, let source, let tokens, let error):
        cell.configure(
          item.block, placement: placement, style: style, label: language,
          code: cached(item.key) { CodeLinesPainter(text: source, tokens: tokens, style: style) }, error: error)
      case .diagram(let source, _):
        cell.configure(
          item.block, placement: placement, style: style, label: "Mermaid",
          code: cached(item.key) { CodeLinesPainter(text: source, tokens: [], style: style) }, error: nil)
      default: break
      }
    }
    let diagram = UICollectionView.CellRegistration<DiagramCell, String> { [unowned self] cell, indexPath, key in
      guard let (item, placement) = model(key, indexPath), case .diagram(_, let drawing?) = item.block.body else { return }
      cell.configure(
        item.block, placement: placement, style: style, shapes: cached(item.key) { DiagramShapes(drawing: drawing, style: style) })
    }
    let chart = UICollectionView.CellRegistration<ChartCell, String> { [unowned self] cell, indexPath, key in
      guard let (item, placement) = model(key, indexPath), case .chart(let chart) = item.block.body else { return }
      cell.configure(item.block, placement: placement, style: style, chart: chart)
    }
    let table = UICollectionView.CellRegistration<TableCell, String> { [unowned self] cell, indexPath, key in
      guard let (item, placement) = model(key, indexPath), case .table(let table) = item.block.body else { return }
      cell.configure(
        item.block, placement: placement, style: style, table: cached(item.key) { TablePainter(table: table, style: style) })
    }
    let image = UICollectionView.CellRegistration<ImageCell, String> { [unowned self] cell, indexPath, key in
      guard let (item, placement) = model(key, indexPath), case .image(let src, let alt) = item.block.body else { return }
      cell.configure(
        item.block, placement: placement, style: style, alt: alt.isEmpty ? src : alt, state: imageState(src, for: key))
    }
    let rule = UICollectionView.CellRegistration<RuleCell, String> { [unowned self] cell, indexPath, key in
      guard let (item, placement) = model(key, indexPath) else { return }
      cell.configure(item.block, placement: placement, style: style)
    }

    return UICollectionViewDiffableDataSource(collectionView: collectionView) { [unowned self] view, indexPath, key in
      let kind = indexPath.item < items.count && items[indexPath.item].key == key ? items[indexPath.item].block.body : .rule
      switch kind {
      case .paragraph, .heading, .unsupported:
        return view.dequeueConfiguredReusableCell(using: text, for: indexPath, item: key)
      case .diagram(_, .some):
        return view.dequeueConfiguredReusableCell(using: diagram, for: indexPath, item: key)
      case .code, .diagram:
        return view.dequeueConfiguredReusableCell(using: code, for: indexPath, item: key)
      case .chart:
        return view.dequeueConfiguredReusableCell(using: chart, for: indexPath, item: key)
      case .table:
        return view.dequeueConfiguredReusableCell(using: table, for: indexPath, item: key)
      case .image:
        return view.dequeueConfiguredReusableCell(using: image, for: indexPath, item: key)
      case .rule:
        return view.dequeueConfiguredReusableCell(using: rule, for: indexPath, item: key)
      }
    }
  }

  private func model(_ key: String, _ indexPath: IndexPath) -> (Item, Placement)? {
    guard indexPath.item < items.count, items[indexPath.item].key == key else { return nil }
    return (items[indexPath.item], placements[indexPath.item])
  }

  private func cached<Value: AnyObject>(_ key: String, _ make: () -> Value) -> Value {
    if let value = renders.object(forKey: key as NSString) as? Value { return value }
    let value = make()
    renders.setObject(value, forKey: key as NSString)
    return value
  }

  private func attributedText(_ item: Item) -> NSAttributedString {
    cached(item.key) { () -> NSAttributedString in
      let image = { [unowned self] (run: Run) in inlineImage(run, for: item.key) }
      switch item.block.body {
      case .heading(let level, let runs):
        let size = style.headingSize(level)
        return style.text(runs, size: size, lineHeight: (size * 1.3).rounded(), weight: .semibold, image: image)
      case .paragraph(let runs):
        return style.text(runs, image: image)
      case .unsupported(let source):
        return style.plain(source, font: style.body, color: style.muted, lineHeight: style.lineHeight)
      default:
        return NSAttributedString()
      }
    }
  }

  private func inlineImage(_ run: Run, for key: String) -> NSAttributedString? {
    guard let src = run.image else { return nil }
    let attachment = NSTextAttachment()
    let height = style.lineHeight - 4
    let state = imageState(src, for: key)
    if case .failed = state, let alt = run.alt, !alt.isEmpty {
      return style.plain(alt, font: .italicSystemFont(ofSize: style.fontSize), color: style.muted, lineHeight: style.lineHeight)
    }
    if case .loaded(let image) = state, image.size.height > 0 {
      attachment.image = image
      let scaledHeight = min(height * 1.5, image.size.height)
      attachment.bounds = CGRect(x: 0, y: -4, width: scaledHeight * image.size.width / image.size.height, height: scaledHeight)
    } else {
      attachment.image = UIImage(systemName: "photo")?.withTintColor(style.muted, renderingMode: .alwaysOriginal)
      attachment.bounds = CGRect(x: 0, y: -3, width: height * 1.2, height: height)
    }
    return NSAttributedString(attachment: attachment)
  }

  private func reconfigure(_ keys: [String]) {
    var snapshot = dataSource.snapshot()
    let present = keys.filter { snapshot.indexOfItem($0) != nil }
    guard !present.isEmpty else { return }
    snapshot.reconfigureItems(present)
    dataSource.apply(snapshot, animatingDifferences: false)
  }


  private var imageDecodeWidth: CGFloat { max(bounds.width, 320) * (window?.screen.scale ?? UIScreen.main.scale) }

  private func imageState(_ src: String, for key: String) -> ImageState {
    imageUsers[src, default: []].insert(key)
    if let state = images[src] { return state }
    images[src] = .loading
    if src.range(of: #"^images/[^/]+$"#, options: .regularExpression) != nil {
      send(.imageRequest, ["src": src])
    } else if let url = URL(string: src), url.scheme == "http" || url.scheme == "https" {
      let width = imageDecodeWidth
      URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
        let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
        let image = ok ? data.flatMap { Self.decode($0, width: width) } : nil
        DispatchQueue.main.async { self?.finishImage(src, image) }
      }.resume()
    } else if src.hasPrefix("data:") {
      provideImage(src: src, dataUrl: src)
    } else {
      images[src] = .failed
    }
    return images[src] ?? .failed
  }

  private static func decode(_ data: Data, width: CGFloat) -> UIImage? {
    guard let image = UIImage(data: data) else { return nil }
    let pixelWidth = image.size.width * image.scale
    guard pixelWidth > width else { return image.preparingForDisplay() ?? image }
    let target = CGSize(width: width, height: (width * image.size.height / image.size.width).rounded())
    return image.preparingThumbnail(of: target).map { UIImage(cgImage: $0.cgImage!, scale: UIScreen.main.scale, orientation: .up) } ?? image
  }

  private func finishImage(_ src: String, _ image: UIImage?) {
    images[src] = image.map(ImageState.loaded) ?? .failed
    let users = Array(imageUsers[src] ?? [])
    for key in users { renders.removeObject(forKey: key as NSString) }
    reconfigure(users)
  }


  private func send(_ type: NativeEventType, _ payload: [String: Any] = [:]) {
    var event = payload
    event["type"] = type.rawValue
    onDocumentEvent(event)
  }

  private func reportContentSize(_ height: CGFloat) {
    guard abs(height - contentHeight) >= 0.5 else { return }
    contentHeight = height
    send(.contentSize, ["height": Double(height)])
  }
}
