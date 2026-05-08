import Foundation
import ScreenCaptureKit
import CoreVideo

@available(macOS 13.0, *)
class ScreenCaptureManager: NSObject, SCStreamDelegate, SCStreamOutput {
    
    private var stream: SCStream?
    private var display: SCDisplay?
    
    struct Resolution: Codable {
        let name: String
        let width: Int
        let height: Int
        
        static let presets: [Resolution] = [
            Resolution(name: "540p", width: 960, height: 540),
            Resolution(name: "720p", width: 1280, height: 720),
            Resolution(name: "1080p", width: 1920, height: 1080),
            Resolution(name: "1440p", width: 2560, height: 1440)
        ]
    }
    
    var currentResolution: Resolution = Resolution.presets[1] // 默认720p
    var onFrameCaptured: ((CMSampleBuffer) -> Void)?
    
    override init() {
        super.init()
        
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(resolutionChanged),
            name: NSNotification.Name("ResolutionChanged"),
            object: nil
        )
    }
    
    @objc func resolutionChanged(_ notification: Notification) {
        if let resolution = notification.userInfo?["resolution"] as? Resolution {
            setResolution(resolution)
        }
    }
    
    func setResolution(_ resolution: Resolution) {
        currentResolution = resolution
        if stream != nil {
            stop()
            start()
        }
    }
    
    func start() {
        SCShareableContent.getWithCompletionHandler { [weak self] content, error in
            guard let self = self else { return }
            
            if let error = error {
                print("Failed to get shareable content: \(error)")
                return
            }
            
            guard let display = content?.displays.first else {
                print("No display available")
                return
            }
            
            self.display = display
            self.setupStream(display: display)
        }
    }
    
    private func setupStream(display: SCDisplay) {
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        
        config.width = currentResolution.width
        config.height = currentResolution.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        
        stream = SCStream(filter: filter, configuration: config, delegate: self)
        
        do {
            try stream?.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .userInteractive))
        } catch {
            print("Failed to add stream output: \(error)")
            return
        }
        
        stream?.startCapture { [weak self] error in
            if let error = error {
                print("Failed to start capture: \(error)")
            } else {
                print("Screen capture started at \(self?.currentResolution.name ?? "unknown")")
            }
        }
    }
    
    func stop() {
        stream?.stopCapture { error in
            if let error = error {
                print("Error stopping capture: \(error)")
            }
        }
        stream = nil
    }
    
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("Stream stopped with error: \(error)")
    }
    
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard sampleBuffer.isValid else { return }
        onFrameCaptured?(sampleBuffer)
    }
}
