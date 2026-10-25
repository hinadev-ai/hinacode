import HinaCodeKit
import SwiftUI

/// A project's favicon, read from its desktop once per project per launch. Without one (or while it loads), a folder.
/// SVG icons also fall back: the phone has no SVG rasterizer outside an asset catalog.
struct ProjectIcon: View {
    let projectId: String

    @Environment(AppModel.self) private var model
    @State private var loaded: (id: String, image: UIImage?)?
    @ScaledMetric(relativeTo: .caption) private var size = 12

    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 64
        return cache
    }()
    @MainActor private static var requested: Set<String> = []

    var body: some View {
        Group {
            if let image = Self.cache.object(forKey: projectId as NSString)
                ?? (loaded?.id == projectId ? loaded?.image : nil)
            {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .task(id: projectId) { await load() }
    }

    private func load() async {
        guard Self.cache.object(forKey: projectId as NSString) == nil, !Self.requested.contains(projectId) else {
            return
        }
        Self.requested.insert(projectId)
        let dataURL = try? await model.hub.call(RPC.projectsIcon, ProjectsIconRequest(id: projectId))
        let image = await (dataURL ?? nil).flatMap(Self.image(fromDataURL:))?.byPreparingForDisplay()
        if let image {
            Self.cache.setObject(image, forKey: projectId as NSString)
        } else {
            // A failure may retry the next time the row is made, like the Expo app.
            Self.requested.remove(projectId)
        }
        loaded = (projectId, image)
    }

    private static func image(fromDataURL dataURL: String) -> UIImage? {
        guard let comma = dataURL.firstIndex(of: ","), dataURL.hasPrefix("data:") else { return nil }
        let header = dataURL[..<comma]
        guard !header.contains("svg") else { return nil }
        let payload = dataURL[dataURL.index(after: comma)...]
        let data =
            if header.hasSuffix(";base64") {
                Data(base64Encoded: String(payload))
            } else {
                payload.removingPercentEncoding.flatMap { Data($0.utf8) }
            }
        return data.flatMap(UIImage.init(data:))
    }
}
