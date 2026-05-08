import Cocoa

class ResolutionPicker {
    static func show() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 250),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        
        window.title = "分辨率设置"
        window.center()
        
        let viewController = ResolutionViewController()
        window.contentViewController = viewController
        
        NSApp.runModal(for: window)
    }
}

class ResolutionViewController: NSViewController {
    var radioButtons: [NSButton] = []
    var selectedResolution: ScreenCaptureManager.Resolution?
    
    override func loadView() {
        self.view = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 250))
    }
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        let titleLabel = NSTextField(labelWithString: "选择投屏分辨率：")
        titleLabel.font = NSFont.boldSystemFont(ofSize: 14)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(titleLabel)
        
        NSLayoutConstraint.activate([
            titleLabel.topAnchor.constraint(equalTo: view.topAnchor, constant: 20),
            titleLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20)
        ])
        
        let resolutions = ScreenCaptureManager.Resolution.presets
        var lastView: NSView = titleLabel
        
        for (index, resolution) in resolutions.enumerated() {
            let button = NSButton(radioButtonWithTitle: "\(resolution.name) (\(resolution.width)x\(resolution.height))", target: self, action: #selector(resolutionChanged(_:)))
            button.tag = index
            button.translatesAutoresizingMaskIntoConstraints = false
            
            if resolution.name == "720p" {
                button.state = .on
                selectedResolution = resolution
            }
            
            radioButtons.append(button)
            view.addSubview(button)
            
            NSLayoutConstraint.activate([
                button.topAnchor.constraint(equalTo: lastView.bottomAnchor, constant: 12),
                button.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20)
            ])
            
            lastView = button
        }
        
        let applyButton = NSButton(title: "应用", target: self, action: #selector(applyResolution))
        applyButton.translatesAutoresizingMaskIntoConstraints = false
        applyButton.keyEquivalent = "\r"
        view.addSubview(applyButton)
        
        let cancelButton = NSButton(title: "取消", target: self, action: #selector(cancel))
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancelButton)
        
        NSLayoutConstraint.activate([
            applyButton.topAnchor.constraint(equalTo: lastView.bottomAnchor, constant: 20),
            applyButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            applyButton.widthAnchor.constraint(equalToConstant: 80),
            
            cancelButton.topAnchor.constraint(equalTo: applyButton.topAnchor),
            cancelButton.trailingAnchor.constraint(equalTo: applyButton.leadingAnchor, constant: -10),
            cancelButton.widthAnchor.constraint(equalToConstant: 80)
        ])
    }
    
    @objc func resolutionChanged(_ sender: NSButton) {
        let index = sender.tag
        selectedResolution = ScreenCaptureManager.Resolution.presets[index]
    }
    
    @objc func applyResolution() {
        guard let resolution = selectedResolution else { return }
        
        NotificationCenter.default.post(
            name: NSNotification.Name("ResolutionChanged"),
            object: nil,
            userInfo: ["resolution": resolution]
        )
        
        view.window?.close()
        NSApp.stopModal()
    }
    
    @objc func cancel() {
        view.window?.close()
        NSApp.stopModal()
    }
}
