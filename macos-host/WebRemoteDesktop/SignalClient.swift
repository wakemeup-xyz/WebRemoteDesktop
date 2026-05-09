import Foundation
import SocketIO
import WebRTC

class SignalClient {
    private var manager: SocketManager?
    private var signalingSocket: SocketIOClient?
    private var inputSocket: SocketIOClient?

    private let serverURL: URL
    private var token: String = ""
    private let password: String

    var onOfferReceived: ((RTCSessionDescription, String) -> Void)?
    var onInputReceived: ((InputController.InputCommand) -> Void)?

    private var currentViewerId: String = ""

    init(serverURL: URL, password: String = "admin123") {
        self.serverURL = serverURL
        self.password = password
    }

    // 获取当前连接的 viewer ID
    func getViewerId() -> String? {
        return currentViewerId.isEmpty ? nil : currentViewerId
    }

    // 先登录获取 token，再连接 WebSocket
    func authenticateAndConnect() {
        login { [weak self] success in
            if success {
                self?.connect()
            } else {
                print("Failed to authenticate")
            }
        }
    }

    private func login(completion: @escaping (Bool) -> Void) {
        let loginURL = serverURL.appendingPathComponent("api/auth/login")
        var request = URLRequest(url: loginURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ["password": password]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if let error = error {
                print("Login request failed: \(error)")
                completion(false)
                return
            }

            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = json["token"] as? String else {
                print("Invalid login response")
                completion(false)
                return
            }

            self?.token = token
            print("Authenticated successfully")
            completion(true)
        }

        task.resume()
    }

    private func connect() {
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

            // 保存 viewer ID 用于发送 ICE candidate
            self?.currentViewerId = viewerId

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