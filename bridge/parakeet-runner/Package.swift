// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "MusafirParakeetRunner",
    platforms: [.macOS(.v14)],
    products: [
        .executable(
            name: "parakeet-transcribe",
            targets: ["parakeet-transcribe"]
        ),
    ],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio",
            revision: "5343241cd8a7576890e50925dec666bafc89d324",
            traits: []
        ),
    ],
    targets: [
        .executableTarget(
            name: "parakeet-transcribe",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        ),
    ]
)
