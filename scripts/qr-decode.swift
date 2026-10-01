// Decode QR codes in PNG files with Apple Vision: swift scripts/qr-decode.swift <png>...
import Foundation
import Vision
import AppKit

for path in CommandLine.arguments.dropFirst() {
    guard let image = NSImage(contentsOfFile: path),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("\(path): cannot read"); continue
    }
    let request = VNDetectBarcodesRequest()
    request.symbologies = [.qr]
    try? VNImageRequestHandler(cgImage: cg).perform([request])
    let payloads = (request.results ?? []).compactMap { $0.payloadStringValue }
    print("\(path): \(cg.width)x\(cg.height) px")
    print(payloads.isEmpty ? "\(path): no QR found" : payloads.map { "\((path as NSString).lastPathComponent) -> \($0)" }.joined(separator: "\n"))
}
