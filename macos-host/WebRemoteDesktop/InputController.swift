import Foundation
import CoreGraphics
import AppKit

struct InputCommand: Codable {
    let type: String
    let action: String
    let payload: [String: Double]?
    let timestamp: Double?
}

class InputController {
    private var displayBounds: CGRect {
        let mainID = CGMainDisplayID()
        return CGDisplayBounds(mainID)
    }
    
    func execute(command: InputCommand) {
        DispatchQueue.main.async { [weak self] in
            switch command.type {
            case "mouse":
                self?.handleMouse(action: command.action, payload: command.payload)
            case "keyboard":
                self?.handleKeyboard(action: command.action, payload: command.payload)
            default:
                break
            }
        }
    }
    
    private func handleMouse(action: String, payload: [String: Double]?) {
        guard let payload = payload else { return }
        
        let relX = payload["relX"] ?? 0
        let relY = payload["relY"] ?? 0
        
        let bounds = displayBounds
        let x = CGFloat(relX) * bounds.width + bounds.origin.x
        let y = CGFloat(relY) * bounds.height + bounds.origin.y
        let point = CGPoint(x: x, y: y)
        
        switch action {
        case "move":
            moveMouse(to: point)
        case "down":
            let button = MouseButton.from(string: payload["button"] as? String ?? "left")
            clickMouse(at: point, button: button, down: true)
        case "up":
            let button = MouseButton.from(string: payload["button"] as? String ?? "left")
            clickMouse(at: point, button: button, down: false)
        case "click":
            let button = MouseButton.from(string: payload["button"] as? String ?? "left")
            clickMouse(at: point, button: button, down: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.clickMouse(at: point, button: button, down: false)
            }
        case "dblclick":
            doubleClick(at: point)
        case "wheel":
            let deltaX = Int32(payload["deltaX"] ?? 0)
            let deltaY = Int32(payload["deltaY"] ?? 0)
            scrollWheel(at: point, deltaX: deltaX, deltaY: deltaY)
        default:
            break
        }
    }
    
    private func handleKeyboard(action: String, payload: [String: Double]?) {
        guard let payload = payload,
              let keyCode = payload["keyCode"].flatMap({ CGKeyCode($0) }) else {
            return
        }
        
        let down = (action == "keydown")
        var modifiers: CGEventFlags = []
        
        if payload["ctrl"] == 1 { modifiers.insert(.maskControl) }
        if payload["shift"] == 1 { modifiers.insert(.maskShift) }
        if payload["alt"] == 1 { modifiers.insert(.maskAlternate) }
        if payload["meta"] == 1 { modifiers.insert(.maskCommand) }
        
        simulateKey(keyCode: keyCode, down: down, modifiers: modifiers)
    }
    
    private func moveMouse(to point: CGPoint) {
        let event = CGEvent(mouseEventSource: nil,
                           mouseType: .mouseMoved,
                           mouseCursorPosition: point,
                           mouseButton: .left)
        event?.post(tap: .cghidEventTap)
    }
    
    private func clickMouse(at point: CGPoint, button: MouseButton, down: Bool) {
        let type: CGEventType
        switch (button, down) {
        case (.left, true): type = .leftMouseDown
        case (.left, false): type = .leftMouseUp
        case (.right, true): type = .rightMouseDown
        case (.right, false): type = .rightMouseUp
        case (.middle, true): type = .otherMouseDown
        case (.middle, false): type = .otherMouseUp
        }
        
        let event = CGEvent(mouseEventSource: nil,
                           mouseType: type,
                           mouseCursorPosition: point,
                           mouseButton: button.cgButton)
        event?.post(tap: .cghidEventTap)
    }
    
    private func doubleClick(at point: CGPoint) {
        clickMouse(at: point, button: .left, down: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.clickMouse(at: point, button: .left, down: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.clickMouse(at: point, button: .left, down: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    self?.clickMouse(at: point, button: .left, down: false)
                }
            }
        }
    }
    
    private func scrollWheel(at point: CGPoint, deltaX: Int32, deltaY: Int32) {
        let event = CGEvent(scrollWheelEvent2: nil, dx: deltaX, dy: deltaY, dz: 0)
        event?.location = point
        event?.post(tap: .cghidEventTap)
    }
    
    private func simulateKey(keyCode: CGKeyCode, down: Bool, modifiers: CGEventFlags) {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down)
        event?.flags = modifiers
        event?.post(tap: .cghidEventTap)
    }
}

enum MouseButton: Int {
    case left = 0
    case middle = 1
    case right = 2
    
    var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }
    
    static func from(string: String) -> MouseButton {
        switch string {
        case "right": return .right
        case "middle": return .middle
        default: return .left
        }
    }
}
