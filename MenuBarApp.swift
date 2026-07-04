import AppKit
import Foundation

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var menu: NSMenu!
    var serverProcess: Process?
    var serverOutputPipe: Pipe?
    var serverErrorPipe: Pipe?
    var pollTimer: Timer?
    
    // Ultra-Minimalist Menu Items
    var codeMenuItem: NSMenuItem!
    var hostLinkMenuItem: NSMenuItem!
    var devicesMenuItem: NSMenuItem!
    var quitMenuItem: NSMenuItem!
    
    func applicationDidFinishLaunching(_ aNotification: Notification) {
        // Set application activation policy to accessory (runs strictly in Menu Bar)
        NSApp.setActivationPolicy(.accessory)
        
        // 1. Create Menu Bar Status Item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        
        if let button = statusItem.button {
            if #available(macOS 11.0, *) {
                button.image = NSImage(systemSymbolName: "keyboard", accessibilityDescription: "AirKeyboard")
                button.image?.isTemplate = true
            } else {
                button.title = "⌨️"
            }
        }
        
        // 2. Build ultra-minimalist dropdown menu
        menu = NSMenu()
        menu.autoenablesItems = false
        
        // Code / Booting display (starts as booting status)
        codeMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        codeMenuItem.isEnabled = false
        setBootingState()
        menu.addItem(codeMenuItem)
        
        // Bonjour Link (Only visible when active)
        hostLinkMenuItem = NSMenuItem(title: "", action: #selector(openHostURL), keyEquivalent: "")
        setLink("")
        menu.addItem(hostLinkMenuItem)
        
        // Connected Devices (Only visible when client is active)
        devicesMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        devicesMenuItem.isEnabled = false
        setDevices("")
        menu.addItem(devicesMenuItem)
        
        menu.addItem(NSMenuItem.separator())
        
        // Quit button (Since server runs continuously, quitting the app stops the server)
        quitMenuItem = NSMenuItem(title: "", action: #selector(quitApp), keyEquivalent: "q")
        setQuitState()
        menu.addItem(quitMenuItem)
        
        statusItem.menu = menu
        
        // Start server automatically on application launch
        startServer()
        
        // Poll for updates (using .common mode so timer fires even when menu is open)
        let timer = Timer(timeInterval: 1.0, target: self, selector: #selector(pollSessionInfo), userInfo: nil, repeats: true)
        RunLoop.current.add(timer, forMode: .common)
        pollTimer = timer
    }
    
    // Futuristic Monospaced Text Helper
    func makeAttributed(_ text: String, color: NSColor, size: CGFloat, bold: Bool = false) -> NSAttributedString {
        let weight: NSFont.Weight = bold ? .bold : .regular
        let font = NSFont.monospacedSystemFont(ofSize: size, weight: weight)
        let attributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: color,
            .font: font
        ]
        return NSAttributedString(string: text, attributes: attributes)
    }
    
    // SF Symbol image config helper
    func setMenuIcon(_ item: NSMenuItem, name: String) {
        if #available(macOS 11.0, *) {
            let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)
            img?.isTemplate = true
            item.image = img
        }
    }
    
    // UI State Setters
    func setBootingState() {
        codeMenuItem.attributedTitle = makeAttributed("Booting...", color: NSColor.systemOrange, size: 11, bold: true)
        setMenuIcon(codeMenuItem, name: "circle.fill")
    }
    
    func setCodeState(code: String) {
        codeMenuItem.attributedTitle = makeAttributed("Code: \(code)", color: NSColor.white, size: 11, bold: true)
        setMenuIcon(codeMenuItem, name: "lock.fill")
    }
    
    func setErrorState() {
        codeMenuItem.attributedTitle = makeAttributed("Start Error", color: NSColor.systemRed, size: 11, bold: true)
        setMenuIcon(codeMenuItem, name: "circle.fill")
    }
    
    func setLink(_ urlStr: String) {
        if urlStr.isEmpty {
            hostLinkMenuItem.isHidden = true
        } else {
            // Trim scheme for clean visual layout
            let cleanLink = urlStr.replacingOccurrences(of: "http://", with: "")
            hostLinkMenuItem.attributedTitle = makeAttributed(cleanLink, color: NSColor(red: 0.54, green: 0.7, blue: 0.98, alpha: 1.0), size: 10) // #89b4fa
            hostLinkMenuItem.isEnabled = true
            hostLinkMenuItem.isHidden = false
        }
        setMenuIcon(hostLinkMenuItem, name: "link")
    }
    
    func setDevices(_ devices: String) {
        if devices.isEmpty {
            devicesMenuItem.isHidden = true
        } else {
            devicesMenuItem.attributedTitle = makeAttributed("Active: \(devices)", color: NSColor.secondaryLabelColor, size: 10)
            devicesMenuItem.isEnabled = false
            devicesMenuItem.isHidden = false
        }
        setMenuIcon(devicesMenuItem, name: "iphone")
    }
    
    func setQuitState() {
        quitMenuItem.attributedTitle = makeAttributed("Quit", color: NSColor.secondaryLabelColor, size: 11)
        setMenuIcon(quitMenuItem, name: "xmark")
    }

    func clearServerPipes() {
        serverOutputPipe?.fileHandleForReading.readabilityHandler = nil
        serverErrorPipe?.fileHandleForReading.readabilityHandler = nil
        serverOutputPipe = nil
        serverErrorPipe = nil
    }
    
    @objc func openHostURL() {
        let title = hostLinkMenuItem.attributedTitle?.string ?? ""
        if !title.isEmpty && !title.contains("offline") {
            let fullURL = "http://\(title)"

            // Copy URL to macOS pasteboard (clipboard)
            let pasteboard = NSPasteboard.general
            pasteboard.declareTypes([.string], owner: nil)
            pasteboard.setString(fullURL, forType: .string)

            // Give visual feedback in the menu
            let originalTitle = hostLinkMenuItem.attributedTitle
            hostLinkMenuItem.attributedTitle = makeAttributed("Copied to clipboard!", color: NSColor.systemGreen, size: 10, bold: true)

            // Revert back to URL after 1.5 seconds
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self = self else { return }
                if self.serverProcess != nil {
                    self.hostLinkMenuItem.attributedTitle = originalTitle
                }
            }
        }
    }
    
    @objc func startServer() {
        if serverProcess == nil {
            let appPath = Bundle.main.bundlePath
            let fm = FileManager.default
            let resourceAppPath = (appPath as NSString).appendingPathComponent("Contents/Resources/app")
            let workingDir = fm.fileExists(atPath: resourceAppPath) ? resourceAppPath : fm.currentDirectoryPath
            
            let infoPath = (workingDir as NSString).appendingPathComponent("session_info.json")
            try? fm.removeItem(atPath: infoPath)
            
            let proc = Process()
            proc.currentDirectoryPath = workingDir
            proc.launchPath = "/bin/bash"
            proc.arguments = ["./start-airkeyboard.sh"]

            let outputPipe = Pipe()
            let errorPipe = Pipe()
            outputPipe.fileHandleForReading.readabilityHandler = { handle in
                _ = handle.availableData
            }
            errorPipe.fileHandleForReading.readabilityHandler = { handle in
                _ = handle.availableData
            }
            proc.standardOutput = outputPipe
            proc.standardError = errorPipe
            serverOutputPipe = outputPipe
            serverErrorPipe = errorPipe

            proc.terminationHandler = { [weak self] finishedProc in
                DispatchQueue.main.async {
                    guard let self = self, self.serverProcess === finishedProc else { return }
                    self.serverProcess = nil
                    self.clearServerPipes()
                    self.setLink("")
                    self.setDevices("")
                    self.setErrorState()
                }
            }
            
            do {
                try proc.run()
                serverProcess = proc
                setBootingState()
            } catch {
                setErrorState()
            }
        }
    }
    
    @objc func stopServer() {
        if let proc = serverProcess {
            proc.terminationHandler = nil
            proc.terminate()
            serverProcess = nil
            clearServerPipes()
            
            let appPath = Bundle.main.bundlePath
            let fm = FileManager.default
            let resourceAppPath = (appPath as NSString).appendingPathComponent("Contents/Resources/app")
            let workingDir = fm.fileExists(atPath: resourceAppPath) ? resourceAppPath : fm.currentDirectoryPath
            let infoPath = (workingDir as NSString).appendingPathComponent("session_info.json")
            try? fm.removeItem(atPath: infoPath)
            
            setLink("")
            setDevices("")
        }
    }
    
    @objc func pollSessionInfo() {
        guard serverProcess != nil else { return }
        
        let appPath = Bundle.main.bundlePath
        let fm = FileManager.default
        let resourceAppPath = (appPath as NSString).appendingPathComponent("Contents/Resources/app")
        let workingDir = fm.fileExists(atPath: resourceAppPath) ? resourceAppPath : fm.currentDirectoryPath
        let infoPath = (workingDir as NSString).appendingPathComponent("session_info.json")
        
        if fm.fileExists(atPath: infoPath) {
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: infoPath))
                if let json = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] {
                    let code = json["code"] as? String ?? "----"
                    let host = json["host"] as? String ?? ""
                    let devices = json["devices"] as? String ?? ""
                    
                    setLink(host)
                    setDevices(devices)
                    setCodeState(code: code)
                }
            } catch {}
        } else {
            // Failsafe: if process stopped but no error thrown
            if let proc = serverProcess, !proc.isRunning {
                stopServer()
                setErrorState()
            }
        }
    }
    
    @objc func quitApp() {
        stopServer()
        NSApp.terminate(nil)
    }
    
    func applicationWillTerminate(_ aNotification: Notification) {
        stopServer()
    }
}

// Start App
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
