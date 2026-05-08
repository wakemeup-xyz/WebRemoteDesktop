import Cocoa
import ScreenCaptureKit
import WebRTC
import SocketIO

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    var statusItem: NSStatusItem?
    
    var captureManager: ScreenCaptureManager?
    var webRTCManager: WebRTCManager?
    var signalClient: SignalClient?
    var inputController: InputController?
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        setupStatusBar()
        checkScreenCapturePermission()
    }
    
    func setupStatusBar() {
        statusItem = NSStatusBar.shared.statusItem(withLength: NSStatusItem.variableLength)
        statusItem?.button?.image = NSImage(systemSymbolName: "rectangle.on.rectangle", accessibilityDescription: "Remote Desktop")
        
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "分辨率设置", action: #selector(showResolutionPicker), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "启动服务", action: #selector(startService), keyEquivalent: "s"))
        menu.addItem(NSMenuItem(title: "停止服务", action: #selector(stopService), keyEquivalent: "x"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        
        statusItem?.menu = menu
    }
    
    func checkScreenCapturePermission() {
        SCShareableContent.getWithCompletionHandler { [weak self] content, error in
            DispatchQueue.main.async {
                if let error = error {
                    self?.showPermissionAlert(error: error)
                } else {
                    print("Screen capture permission granted")
                }
            }
        }
    }
    
    func showPermissionAlert(error: Error) {
        let alert = NSAlert()
        alert.messageText = "需要屏幕录制权限"
        alert.informativeText = "请在系统设置 > 隐私与安全 > 屏幕录制中启用权限"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "打开设置")
        alert.addButton(withTitle: "取消")
        
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
        }
    }
    
    @objc func showResolutionPicker() {
        ResolutionPicker.show()
    }
    
    @objc func startService() {
        captureManager = ScreenCaptureManager()
        webRTCManager = WebRTCManager()
        inputController = InputController()
        
        signalClient = SignalClient(
            serverURL: URL(string: "http://localhost:8080")!,
            token: "PLACEHOLDER_TOKEN"
        )
        
        setupSignalHandlers()
        
        signalClient?.connect()
        updateStatusMenu(running: true)
    }
    
    func setupSignalHandlers() {
        signalClient?.onOfferReceived = { [weak self] offer, viewerId in
            self?.webRTCManager?.handleOffer(offer) { result in
                switch result {
                case .success(let answer):
                    self?.signalClient?.sendAnswer(answer, to: viewerId)
                case .failure(let error):
                    print("Failed to create answer: \(error)")
                }
            }
        }
        
        signalClient?.onInputReceived = { [weak self] command in
            self?.inputController?.execute(command: command)
        }
        
        webRTCManager?.onIceCandidate = { [weak self] candidate in
            print("Generated ICE candidate")
        }
    }
    
    @objc func stopService() {
        signalClient?.disconnect()
        webRTCManager?.close()
        captureManager?.stop()
        
        updateStatusMenu(running: false)
    }
    
    func updateStatusMenu(running: Bool) {
        let iconName = running ? "rectangle.on.rectangle.fill" : "rectangle.on.rectangle"
        statusItem?.button?.image = NSImage(systemSymbolName: iconName, accessibilityDescription: "Remote Desktop")
    }
}
