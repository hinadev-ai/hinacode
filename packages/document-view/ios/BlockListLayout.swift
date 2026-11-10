import UIKit

/// A vertical list of full-width rows that size themselves. Row heights live in an array, so a row that resolves its
/// height moves the rows below it with a prefix sum. An estimated compositional layout re-solves its whole section for
/// that instead, which costs frames once a document holds thousands of blocks.
final class BlockListLayout: UICollectionViewLayout {
  private static let estimatedHeight: CGFloat = 48
  private static let top: CGFloat = 16
  private static let bottom: CGFloat = 32

  private var heights: [CGFloat] = []
  /// `origins[i]` is where row `i` starts and `origins[heights.count]` where the last row ends.
  private var origins: [CGFloat] = [top]
  private var validOrigins = 1
  private var width: CGFloat = 0

  /// Mirrors a patch the data source is about to apply: the rows in `range` become `count` rows of unknown height.
  func replace(_ range: Range<Int>, count: Int) {
    heights.replaceSubrange(range, with: repeatElement(Self.estimatedHeight, count: count))
    origins.replaceSubrange((range.lowerBound + 1)..<(range.upperBound + 1), with: repeatElement(0, count: count))
    validOrigins = min(validOrigins, range.lowerBound + 1)
  }

  override func prepare() {
    super.prepare()
    if let collectionView { width = collectionView.bounds.width }
    for index in validOrigins..<origins.count { origins[index] = origins[index - 1] + heights[index - 1] }
    validOrigins = origins.count
  }

  override var collectionViewContentSize: CGSize { CGSize(width: width, height: origins[heights.count] + Self.bottom) }

  override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
    var index = firstRow(endingAfter: rect.minY)
    var attributes: [UICollectionViewLayoutAttributes] = []
    while index < heights.count, origins[index] < rect.maxY {
      attributes.append(self.attributes(index))
      index += 1
    }
    return attributes
  }

  override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    indexPath.item < heights.count ? attributes(indexPath.item) : nil
  }

  override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool { newBounds.width != width }

  override func shouldInvalidateLayout(
    forPreferredLayoutAttributes preferredAttributes: UICollectionViewLayoutAttributes,
    withOriginalAttributes originalAttributes: UICollectionViewLayoutAttributes
  ) -> Bool {
    let index = preferredAttributes.indexPath.item
    return index < heights.count && abs(preferredAttributes.size.height - heights[index]) >= 0.5
  }

  override func invalidationContext(
    forPreferredLayoutAttributes preferredAttributes: UICollectionViewLayoutAttributes,
    withOriginalAttributes originalAttributes: UICollectionViewLayoutAttributes
  ) -> UICollectionViewLayoutInvalidationContext {
    let context = super.invalidationContext(
      forPreferredLayoutAttributes: preferredAttributes, withOriginalAttributes: originalAttributes)
    let index = preferredAttributes.indexPath.item
    let change = preferredAttributes.size.height - heights[index]
    heights[index] = preferredAttributes.size.height
    validOrigins = min(validOrigins, index + 1)
    context.contentSizeAdjustment = CGSize(width: 0, height: change)
    if let collectionView, origins[index] < collectionView.contentOffset.y + collectionView.adjustedContentInset.top {
      context.contentOffsetAdjustment = CGPoint(x: 0, y: change)
    }
    return context
  }

  private func attributes(_ index: Int) -> UICollectionViewLayoutAttributes {
    let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
    attributes.frame = CGRect(x: 0, y: origins[index], width: width, height: heights[index])
    return attributes
  }

  private func firstRow(endingAfter y: CGFloat) -> Int {
    var low = 0
    var high = heights.count
    while low < high {
      let middle = (low + high) / 2
      if origins[middle + 1] > y { high = middle } else { low = middle + 1 }
    }
    return low
  }
}
