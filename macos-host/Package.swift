// swift-tools-version:5.8
import PackageDescription

let package = Package(
    name: "WebRemoteDesktop",
    platforms: [.macOS(.v13)],
    products: [
        .executable(
            name: "WebRemoteDesktop",
            targets: ["WebRemoteDesktop"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", from: "115.0.0"),
        .package(url: "https://github.com/socketio/socket.io-client-swift.git", from: "16.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "WebRemoteDesktop",
            dependencies: [
                .product(name: "WebRTC", package: "WebRTC"),
                .product(name: "SocketIO", package: "socket.io-client-swift"),
            ],
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency")
            ]
        ),
    ]
)
