import Foundation

/// Results derived from a text, kept for the session, since a transcript renders the same replies again and again
/// while one of them streams. The system drops entries under memory pressure.
final class TextCache<Value> {
    private final class Box {
        let value: Value
        init(_ value: Value) { self.value = value }
    }

    private let cache = NSCache<NSString, Box>()

    /// `totalCost` bounds the summed UTF-16 lengths of the keys.
    init(countLimit: Int, totalCost: Int = 0) {
        cache.countLimit = countLimit
        cache.totalCostLimit = totalCost
    }

    subscript(key: String) -> Value? {
        get { cache.object(forKey: key as NSString)?.value }
        set {
            if let newValue {
                cache.setObject(Box(newValue), forKey: key as NSString, cost: key.utf16.count)
            } else {
                cache.removeObject(forKey: key as NSString)
            }
        }
    }
}
