import Foundation
import SocketIO
import WebRTC

class SignalClient {
    private var manager: SocketManager?
    private var signalingSocket: SocketIOClient?
    private var inputSocket: SocketIOClient?
    
    private let serverURL: URL
    private let token: String
    
    var onOfferReceived: ((RTCSessionDescription, String) -> Void)?
    var onInputReceived: ((InputController.InputCommand) -> Void)?
    
    init(serverURL: URL, token: String) {
        self.serverURL = serverURL
        self.token = token
    }
    
    func connect() {
        let config: SocketIOClientConfiguration = [
            .compress,
            .extraHeaders(["Authorization": "Bearer \(token)"])
        ]
        
        manager = SocketManager(socketURL: serverURL, config: config)
        
        signalingSocket = manager?.socket(forNamespace: "/signal")
        inputSocket = manager?.socket(forNamespace: "/input")
        
        setupSignalingHandlers()
        setupInputHandlers()
        
        signalingSocket?.connect(withPayload: ["role": "host", "token": token])
        inputSocket?.connect(withPayload: ["role": "host", "token": token])
    }
    
    private func setupSignalingHandlers() {
        signalingSocket?.on(clientEvent: .connect) { _, _ in
            print("Signaling connected")
        }
        
        signalingSocket?.on("connected") { _, _ in
            print("Server acknowledged signaling connection")
        }
        
        signalingSocket?.on("offer") { [weak self] data, _ in
            guard let data = data.first as? [String: Any],
                  let offerDict = data["offer"] as? [String: Any],
                  let sdp = offerDict["sdp"] as? String,
                  let viewerId = data["viewerId"] as? String else {
                return
            }
            
            let offer = RTCSessionDescription(type: .offer, sdp: sdp)
            self?.onOfferReceived?(offer, viewerId)
        }
        
        signalingSocket?.on("ice-candidate") { [weak self] data, _ in
            guard let data = data.first as? [String: Any],
                  let candidateDict = data["candidate"] as? [String: Any] else {
                return
            }
            
            let sdp = candidateDict["candidate"] as? String ?? ""
            let sdpMLineIndex = candidateDict["sdpMLineIndex"] as? Int32 ?? 0
            let sdpMid = candidateDict["sdpMid"] as? String
            
            let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: sdpMLineIndex, sdpMid: sdpMid)
            NotificationCenter.default.post(name: .init("NewIceCandidate"), object: nil, userInfo: ["candidate": candidate])
        }
    }
    
    private func setupInputHandlers() {
        inputSocket?.on(clientEvent: .connect) { _, _ in
            print("Input channel connected")
        }
        
        inputSocket?.on("connected") { _, _ in
            print("Server acknowledged input connection")
        }
        
        inputSocket?.on("input") { [weak self] data, _ in
            guard let data = data.first as? [String: Any] else { return }
            
            let command = InputController.InputCommand(
                type: data["type"] as? String ?? "",
                action: data["action"] as? String ?? "",
                payload: data["payload"] as? [String: Double],
                timestamp: data["timestamp"] as? Double
            )
            
            self?.onInputReceived?(command)
        }
    }
    
    func sendAnswer(_ answer: RTCSessionDescription, to viewerId: String) {
        let data: [String: Any] = [
            "answer": ["type": "answer", "sdp": answer.sdp],
            "viewerId": viewerId
        ]
        signalingSocket?.emit("answer", data)
    }
    
    func sendIceCandidate(_ candidate: RTCIceCandidate, to viewerId: String) {
        let data: [String: Any] = [
            "target": "viewer",
            "viewerId": viewerId,
            "candidate": [
                "candidate": candidate.sdp,
                "sdpMLineIndex": candidate.sdpMLineIndex,
                "sdpMid": candidate.sdpMid ?? ""
            ]
        ]
        signalingSocket?.emit("ice-candidate", data)
    }
    
    func disconnect() {
        signalingSocket?.disconnect()
        inputSocket?.disconnect()
        manager?.disconnect()
    }
}
