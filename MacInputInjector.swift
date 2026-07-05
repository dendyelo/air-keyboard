import Foundation
import CoreGraphics
import ApplicationServices

// Virtual keycodes
let kVK_Delete: CGKeyCode = 0x33
let kVK_Return: CGKeyCode = 0x24
let kVK_Space: CGKeyCode = 0x31
let kVK_UpArrow: CGKeyCode = 0x7E
let kVK_DownArrow: CGKeyCode = 0x7D
let kVK_LeftArrow: CGKeyCode = 0x7B
let kVK_RightArrow: CGKeyCode = 0x7C
let kVK_Tab: CGKeyCode = 0x30
let kVK_Escape: CGKeyCode = 0x35

func postVirtualKey(code: CGKeyCode) {
    let source = CGEventSource(stateID: .hidSystemState)
    let keyDown = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    let keyUp = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    keyDown?.post(tap: .cghidEventTap)
    keyUp?.post(tap: .cghidEventTap)
}

func postUnicodeString(_ string: String) {
    for char in string {
        if char == " " {
            postVirtualKey(code: kVK_Space)
        } else {
            let source = CGEventSource(stateID: .hidSystemState)
            let utf16 = Array(String(char).utf16)
            
            let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0x00, keyDown: true)
            keyDown?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            keyDown?.post(tap: .cghidEventTap)
            
            let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0x00, keyDown: false)
            keyUp?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            keyUp?.post(tap: .cghidEventTap)
        }
    }
}

func postMouseClick(button: CGMouseButton) {
    let source = CGEventSource(stateID: .hidSystemState)
    let ourEvent = CGEvent(source: source)
    let point = ourEvent?.location ?? CGPoint.zero
    
    let clickDownType: CGEventType = button == .left ? .leftMouseDown : .rightMouseDown
    let clickUpType: CGEventType = button == .left ? .leftMouseUp : .rightMouseUp
    
    let clickDown = CGEvent(mouseEventSource: source, mouseType: clickDownType, mouseCursorPosition: point, mouseButton: button)
    let clickUp = CGEvent(mouseEventSource: source, mouseType: clickUpType, mouseCursorPosition: point, mouseButton: button)
    
    clickDown?.post(tap: .cghidEventTap)
    usleep(10000) // 10ms delay
    clickUp?.post(tap: .cghidEventTap)
}

func postMouseMove(dx: Double, dy: Double) {
    let source = CGEventSource(stateID: .hidSystemState)
    let ourEvent = CGEvent(source: source)
    let point = ourEvent?.location ?? CGPoint.zero
    
    let newPoint = CGPoint(x: point.x + CGFloat(dx), y: point.y + CGFloat(dy))
    let moveEvent = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: newPoint, mouseButton: .left)
    moveEvent?.post(tap: .cghidEventTap)
}

func postMouseScroll(dy: Int32, dx: Int32) {
    let source = CGEventSource(stateID: .hidSystemState)
    let scrollEvent = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    scrollEvent?.post(tap: .cghidEventTap)
}

func postZoom(amount: Int32) {
    let source = CGEventSource(stateID: .hidSystemState)
    let scrollEvent = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: amount, wheel2: 0, wheel3: 0)
    scrollEvent?.flags = .maskCommand
    scrollEvent?.post(tap: .cghidEventTap)
}

func clamp(_ value: Double, min minValue: Double, max maxValue: Double) -> Double {
    return min(max(value, minValue), maxValue)
}

func checkAccessibility() -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    return AXIsProcessTrustedWithOptions(options as CFDictionary)
}

func main() {
    if !checkAccessibility() {
        print("ERROR: Accessibility permission not granted. Please allow in System Settings.")
        fflush(stdout)
    } else {
        print("READY")
        fflush(stdout)
    }
    
    // Read stdin line by line
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .newlines)
        if trimmed.isEmpty { continue }
        
        if trimmed.hasPrefix("KEY:") {
            let key = String(trimmed.dropFirst(4))
            switch key.lowercased() {
            case "backspace", "delete":
                postVirtualKey(code: kVK_Delete)
            case "enter", "return":
                postVirtualKey(code: kVK_Return)
            case "space":
                postVirtualKey(code: kVK_Space)
            case "up":
                postVirtualKey(code: kVK_UpArrow)
            case "down":
                postVirtualKey(code: kVK_DownArrow)
            case "left":
                postVirtualKey(code: kVK_LeftArrow)
            case "right":
                postVirtualKey(code: kVK_RightArrow)
            case "tab":
                postVirtualKey(code: kVK_Tab)
            case "escape", "esc":
                postVirtualKey(code: kVK_Escape)
            default:
                break
            }
        } else if trimmed.hasPrefix("TXT64:") {
            let encoded = String(trimmed.dropFirst(6))
            if let data = Data(base64Encoded: encoded), let text = String(data: data, encoding: .utf8) {
                postUnicodeString(text)
            }
        } else if trimmed.hasPrefix("TXT:") {
            let text = String(trimmed.dropFirst(4))
            postUnicodeString(text)
        } else if trimmed.hasPrefix("MSE:") {
            let mcmd = String(trimmed.dropFirst(4))
            if mcmd == "click" {
                postMouseClick(button: .left)
            } else if mcmd == "rclick" {
                postMouseClick(button: .right)
            } else if mcmd.hasPrefix("move:") {
                let coords = String(mcmd.dropFirst(5)).split(separator: ",")
                if coords.count == 2, let dx = Double(coords[0]), let dy = Double(coords[1]), dx.isFinite, dy.isFinite {
                    postMouseMove(dx: clamp(dx, min: -500, max: 500), dy: clamp(dy, min: -500, max: 500))
                }
            } else if mcmd.hasPrefix("scroll:") {
                let coords = String(mcmd.dropFirst(7)).split(separator: ",")
                if coords.count == 2, let dy = Int32(coords[0]), let dx = Int32(coords[1]) {
                    postMouseScroll(dy: dy, dx: dx)
                } else if coords.count == 1, let dy = Int32(coords[0]) {
                    postMouseScroll(dy: dy, dx: 0)
                }
            } else if mcmd.hasPrefix("zoom:") {
                let sval = String(mcmd.dropFirst(5))
                if let amount = Int32(sval) {
                    postZoom(amount: amount)
                }
            }
        }
    }
}

main()
