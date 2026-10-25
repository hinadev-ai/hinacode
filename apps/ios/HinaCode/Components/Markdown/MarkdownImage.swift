import HinaCodeKit
import SwiftUI

/// Where a Markdown image's relative path resolves, and how to read a workspace file.
struct MarkdownImages {
    let root: String?
    let folder: String
    let load: MarkdownView.LoadImage
}

/// An image from a reply. A URL loads directly, a path loads from the thread's working folder, and anything that
/// cannot load shows its path instead of a broken frame.
struct MarkdownImage: View {
    let source: String
    let alt: String
    let images: MarkdownImages

    var body: some View {
        let written = source.removingPercentEncoding ?? source
        switch MarkdownPath.imageSource(source, root: images.root, folder: images.folder) {
        case .uri(let uri):
            if let url = URL(string: uri) {
                LoadedImage(key: uri, path: written, alt: alt) { try await URLSession.shared.data(from: url).0 }
            } else {
                ImageUnavailable(path: written, alt: alt)
            }
        case .file(let root, let path):
            LoadedImage(key: "\(root)\0\(path)", path: path, alt: alt) { try await images.load(root, path) }
        case .unavailable:
            ImageUnavailable(path: written, alt: alt)
        }
    }
}

/// Loads its image once for the session, so scrolling back through a transcript shows it at once. This is not
/// `AsyncImage`, which loads again each time its view is made and cannot tell the image's own size.
private struct LoadedImage: View {
    let key: String
    let path: String
    let alt: String
    let load: @MainActor () async throws -> Data

    /// A nil image is a failed load.
    @State private var loaded: (key: String, image: UIImage?)?

    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 24
        return cache
    }()

    var body: some View {
        Group {
            if let image = Self.cache.object(forKey: key as NSString) ?? (loaded?.key == key ? loaded?.image : nil) {
                ImageFrame(image: image, label: alt.isEmpty ? path : alt)
            } else if loaded?.key == key {
                ImageUnavailable(path: path, alt: alt)
            } else {
                ImagePlaceholder()
            }
        }
        .task(id: key) {
            guard Self.cache.object(forKey: key as NSString) == nil else { return }
            let data = try? await load()
            let image = await data.flatMap { UIImage(data: $0) }?.byPreparingForDisplay()
            if let image { Self.cache.setObject(image, forKey: key as NSString) }
            loaded = (key, image)
        }
    }
}

/// A loaded image, fitted to the width and never stretched past its own size. Tapping it shows it full screen.
private struct ImageFrame: View {
    let image: UIImage
    let label: String

    @State private var isOpen = false

    var body: some View {
        Button {
            isOpen = true
        } label: {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .clipShape(.rect(cornerRadius: 10))
                .frame(maxWidth: image.size.width, maxHeight: 420, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(.mobileImageOpen(label)))
        .accessibilityAddTraits(.isImage)
        .fullScreenCover(isPresented: $isOpen) {
            Button {
                isOpen = false
            } label: {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding(16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(.mobileImageClose))
            .presentationBackground(.black)
        }
    }
}

private struct ImagePlaceholder: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(.fill.quaternary)
            .frame(maxWidth: .infinity)
            .frame(height: 160)
            .overlay { ProgressView() }
            .accessibilityHidden(true)
    }
}

private struct ImageUnavailable: View {
    let path: String
    let alt: String

    var body: some View {
        Label {
            Text(verbatim: alt.isEmpty || alt == path ? path : "\(alt) (\(path))")
                .lineLimit(2)
        } icon: {
            Image(systemName: "photo")
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.fill.quaternary, in: .rect(cornerRadius: 6))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(.mobileImageUnavailable(path)))
    }
}
