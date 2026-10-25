// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "HinaCodeKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [.library(name: "HinaCodeKit", targets: ["HinaCodeKit"])],
    targets: [
        .target(name: "HinaCodeKit"),
        .testTarget(name: "HinaCodeKitTests", dependencies: ["HinaCodeKit"]),
    ]
)
