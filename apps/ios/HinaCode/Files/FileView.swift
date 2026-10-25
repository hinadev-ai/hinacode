import HinaCodeKit
import SwiftUI
import WebKit

/// One workspace file: code with line numbers, Markdown with a preview, an image, or an SVG. `line` (1-based) is
/// scrolled to and flashed in the code view.
struct FileView: View {
    let threadId: String
    let path: String
    let line: Int?

    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var copied = false

    private var thread: AgentThread? { model.threads.threads[threadId] }
    private var name: String { FileKind.basename(path) }
    private var folder: String { FileKind.dirname(path) }

    var body: some View {
        Group {
            if let thread {
                if let root = model.threads.root(of: thread) {
                    content(root: root)
                } else {
                    ProgressView(.mobileFilesFindingWorkspace)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if model.threads.status == .loading {
                ProgressView(.mobileFilesLoadingThread)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView(.mobileFilesThreadMissing, systemImage: "questionmark.circle")
            }
        }
        .navigationTitle(Text(verbatim: name))
        .navigationSubtitle(folder.isEmpty ? Text(verbatim: "") : Text(verbatim: folder))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        copyPath()
                    } label: {
                        Label(.mobileFilesCopyPath, systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                } label: {
                    Label(.mobileFilesCopyPath, systemImage: "ellipsis.circle")
                }
            }
        }
    }

    @ViewBuilder private func content(root: String) -> some View {
        switch FileKind(path: path) {
        case .image:
            ImageFileView(root: root, path: path, name: name)
        case .svg:
            TextFileView(threadId: threadId, root: root, path: path, line: line, kind: .svg)
        case .markdown:
            TextFileView(threadId: threadId, root: root, path: path, line: line, kind: .markdown)
        case .text:
            TextFileView(threadId: threadId, root: root, path: path, line: line, kind: .text)
        }
    }

    private func copyPath() {
        UIPasteboard.general.string = path
        copied = true
        AccessibilityNotification.Announcement(String(localized: .mobileThreadActionsCopied)).post()
        Task {
            try? await Task.sleep(for: .milliseconds(800))
            copied = false
        }
    }
}

/// Reads a workspace file's bytes through `fs.preview`, for images and Markdown previews.
enum WorkspacePreview {
    @MainActor static func data(model: AppModel, root: String, path: String) async throws -> Data {
        let response = try await model.hub.call(RPC.fsPreview, FsPreviewRequest(root: root, path: path))
        guard let data = data(fromDataURL: response.dataUrl) else {
            throw RpcError("SchemaError", "The desktop sent a preview this build cannot read.")
        }
        return data
    }

    static func data(fromDataURL dataURL: String) -> Data? {
        guard let comma = dataURL.firstIndex(of: ","), dataURL.hasPrefix("data:") else { return nil }
        let header = dataURL[..<comma]
        let payload = dataURL[dataURL.index(after: comma)...]
        return
            if header.hasSuffix(";base64")
        {
            Data(base64Encoded: String(payload))
        } else {
            payload.removingPercentEncoding.flatMap { Data($0.utf8) }
        }
    }
}

/// A text, Markdown or SVG file, read with `fs.read`.
private struct TextFileView: View {
    let threadId: String
    let root: String
    let path: String
    let line: Int?
    let kind: FileKind

    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var state: State = .loading
    @State private var reloads = 0
    @State private var showsPreview: Bool?

    private enum State: Equatable {
        case loading
        case failed(String)
        case loaded(FsFileContent)
    }

    private enum MarkdownMode: Hashable {
        case preview, source
    }

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView(.mobileFilesLoadingFile)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label(.mobileFilesOpenFailed(message), systemImage: "exclamationmark.triangle")
                } actions: {
                    Button(.mobileFilesRetry) { reloads += 1 }
                        .buttonStyle(.borderedProminent)
                }
            case .loaded(let file):
                loaded(file)
            }
        }
        .task(id: "\(root)\0\(path)\0\(reloads)") { await load() }
    }

    @ViewBuilder private func loaded(_ file: FsFileContent) -> some View {
        if file.binary {
            ContentUnavailableView {
                Label(.mobileFilesBinary, systemImage: "doc")
            } description: {
                Text(.mobileFilesBinaryHint)
            }
        } else {
            VStack(spacing: 0) {
                if file.truncated {
                    Label(.mobileFilesTruncated, systemImage: "exclamationmark.triangle")
                        .font(.subheadline)
                        .foregroundStyle(Tone.attention.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                        .padding(.vertical, 8)
                }
                switch kind {
                case .svg:
                    svg(file.content)
                case .markdown:
                    markdown(file.content)
                case .image, .text:
                    CodeFileView(text: file.content, path: path, highlightedLine: line)
                }
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: file.content)
                }
            }
        }
    }

    @ViewBuilder private func markdown(_ content: String) -> some View {
        if content.isEmpty {
            ContentUnavailableView(.mobileFilesEmptyFile, systemImage: "doc.text")
        } else {
            let preview = showsPreview ?? (line == nil)
            VStack(spacing: 0) {
                Picker(
                    .mobileFilesViewLabel,
                    selection: Binding(
                        get: { preview ? MarkdownMode.preview : .source },
                        set: { showsPreview = $0 == .preview })
                ) {
                    Text(.mobileFilesPreview).tag(MarkdownMode.preview)
                    Text(.mobileFilesSource).tag(MarkdownMode.source)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal)
                .padding(.vertical, 6)
                if preview {
                    ScrollView {
                        MarkdownView(
                            content, root: root, folder: FileKind.dirname(path),
                            loadImage: { try await WorkspacePreview.data(model: model, root: $0, path: $1) },
                            openFile: { router.path.append(.file(threadId: threadId, path: $0, line: $1)) }
                        )
                        .padding()
                        .frame(maxWidth: 720)
                        .frame(maxWidth: .infinity)
                    }
                } else {
                    CodeFileView(text: content, path: path, highlightedLine: line)
                }
            }
        }
    }

    @ViewBuilder private func svg(_ content: String) -> some View {
        if content.range(of: "<svg", options: .caseInsensitive) == nil {
            ContentUnavailableView(.mobileFilesSvgFailed, systemImage: "photo")
        } else {
            SVGView(xml: content)
                .aspectRatio(FileKind.svgAspectRatio(content) ?? 1, contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.secondarySystemBackground))
                .accessibilityLabel(Text(.mobileFilesImageLabel(FileKind.basename(path))))
        }
    }

    private func load() async {
        state = .loading
        do {
            state = .loaded(try await model.hub.call(RPC.fsRead, FsReadRequest(root: root, path: path)))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

/// An SVG drawn by WebKit, the phone's only SVG rasterizer outside an asset catalog. Pinching zooms 1x to 4x.
private struct SVGView: UIViewRepresentable {
    let xml: String

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.minimumZoomScale = 1
        view.scrollView.maximumZoomScale = 4
        view.loadHTMLString(
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>html,body{margin:0;height:100%}svg{width:100%;height:100%}</style>\(xml)",
            baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// An image file through `fs.preview`, fitted to the width and never past its own size. Pinching zooms 1x to 4x.
private struct ImageFileView: View {
    let root: String
    let path: String
    let name: String

    @Environment(AppModel.self) private var model
    @State private var state: State = .loading
    @State private var reloads = 0
    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    private enum State {
        case loading
        case failed(String)
        case loaded(UIImage)
    }

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView(.mobileFilesLoadingFile)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label(.mobileFilesOpenFailed(message), systemImage: "exclamationmark.triangle")
                } actions: {
                    Button(.mobileFilesRetry) { reloads += 1 }
                        .buttonStyle(.borderedProminent)
                }
            case .loaded(let image):
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: image.size.width)
                        .scaleEffect(min(max(scale * pinch, 1), 4))
                        .frame(maxWidth: .infinity, minHeight: 96)
                        .padding()
                }
                .background(Color(.secondarySystemBackground))
                .gesture(
                    MagnifyGesture()
                        .updating($pinch) { value, state, _ in state = value.magnification }
                        .onEnded { scale = min(max(scale * $0.magnification, 1), 4) }
                )
                .onTapGesture(count: 2) { scale = 1 }
                .accessibilityLabel(Text(.mobileFilesImageLabel(name)))
                .accessibilityZoomAction { action in
                    scale = action.direction == .zoomIn ? min(scale * 1.5, 4) : max(scale / 1.5, 1)
                }
            }
        }
        .task(id: "\(root)\0\(path)\0\(reloads)") { await load() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                ShareLink(item: path)
            }
        }
    }

    private func load() async {
        state = .loading
        do {
            let data = try await WorkspacePreview.data(model: model, root: root, path: path)
            if let image = await UIImage(data: data)?.byPreparingForDisplay() {
                state = .loaded(image)
            } else {
                state = .failed(String(localized: .mobileFilesImageFailed))
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
