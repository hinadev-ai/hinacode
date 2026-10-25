import SwiftUI
import Vision
import VisionKit

/// The system QR scanner. `onScan` returns whether it took the code; scanning goes on until one is taken.
struct PairingScanner: UIViewControllerRepresentable {
    let onScan: (String) -> Bool

    /// False on devices without a camera that can scan, such as the simulator, so the scan button stays hidden.
    static var isSupported: Bool { DataScannerViewController.isSupported }

    /// False while the camera is denied or restricted.
    static var isAvailable: Bool { DataScannerViewController.isAvailable }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onScan = onScan
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onScan: (String) -> Bool
        private var taken = false

        init(onScan: @escaping (String) -> Bool) {
            self.onScan = onScan
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]
        ) {
            guard !taken else { return }
            for case .barcode(let barcode) in addedItems {
                guard let text = barcode.payloadStringValue else { continue }
                if onScan(text) {
                    taken = true
                    dataScanner.stopScanning()
                    return
                }
            }
        }
    }
}
