import Foundation
import WebRTC
import CoreMedia

class WebRTCManager: NSObject, RTCPeerConnectionDelegate {
    
    private var peerConnection: RTCPeerConnection?
    private var videoSource: RTCVideoSource?
    private var videoTrack: RTCVideoTrack?
    private var factory: RTCPeerConnectionFactory?
    
    var onIceCandidate: ((RTCIceCandidate) -> Void)?
    var onFrameToSend: ((CMSampleBuffer) -> Void)?
    
    override init() {
        super.init()
        setupWebRTC()
    }
    
    private func setupWebRTC() {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory()
        videoSource = factory?.videoSource()
        videoTrack = factory?.videoTrack(with: videoSource!, trackId: "screen")
        
        let config = RTCConfiguration()
        config.iceServers = [
            RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"]),
            RTCIceServer(urlStrings: ["stun:stun1.l.google.com:19302"])
        ]
        
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        peerConnection = factory?.peerConnection(with: config, constraints: constraints, delegate: self)
        
        let stream = factory?.mediaStream(withStreamId: "screen-stream")
        stream?.addVideoTrack(videoTrack!)
        peerConnection?.add(stream!)
    }
    
    func handleOffer(_ offer: RTCSessionDescription, completion: @escaping (Result<RTCSessionDescription, Error>) -> Void) {
        peerConnection?.setRemoteDescription(offer) { [weak self] error in
            if let error = error {
                completion(.failure(error))
                return
            }
            
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            self?.peerConnection?.answer(for: constraints) { answer, error in
                if let error = error {
                    completion(.failure(error))
                    return
                }
                
                guard let answer = answer else {
                    completion(.failure(NSError(domain: "WebRTC", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to create answer"])))
                    return
                }
                
                self?.peerConnection?.setLocalDescription(answer) { error in
                    if let error = error {
                        completion(.failure(error))
                    } else {
                        completion(.success(answer))
                    }
                }
            }
        }
    }
    
    func addIceCandidate(_ candidate: RTCIceCandidate) {
        peerConnection?.add(candidate)
    }
    
    func pushFrame(_ sampleBuffer: CMSampleBuffer) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        
        let rtcpixelBuffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let timeStampNs = CMTimeGetSeconds(timestamp) * Double(NSEC_PER_SEC)
        
        let videoFrame = RTCVideoFrame(buffer: rtcpixelBuffer, rotation: ._0, timeStampNs: Int64(timeStampNs))
        
        videoSource?.capturer(RTCVideoCapturer(delegate: videoSource!), didCapture: videoFrame)
    }
    
    func close() {
        peerConnection?.close()
        peerConnection = nil
    }
    
    // MARK: - RTCPeerConnectionDelegate
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        onIceCandidate?(candidate)
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
