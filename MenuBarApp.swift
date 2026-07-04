import AppKit
import Foundation

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var menu: NSMenu!
    var serverProcess: Process?
    var serverOutputPipe: Pipe?
    var serverErrorPipe: Pipe?
    var pollTimer: Timer?
    
    // Menu items
    var titleMenuItem: NSMenuItem!
    var statusMenuItem: NSMenuItem!
    var codeMenuItem: NSMenuItem!
    var hostLinkMenuItem: NSMenuItem!
    var devicesMenuItem: NSMenuItem!
    var toggleServerMenuItem: NSMenuItem!
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
        
        // 2. Build futuristic dropdown menu
        menu = NSMenu()
        menu.autoenablesItems = false
        
        // App Title (Futuristic design label)
        titleMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        titleMenuItem.isEnabled = false
        titleMenuItem.attributedTitle = makeAttributed("AIRKEYBOARD", color: NSColor(red: 0.8, green: 0.65, blue: 0.97, alpha: 1.0), size: 10, bold: true) // Mauve
        menu.addItem(titleMenuItem)
        
        // Status indicator
        statusMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        setStatusOffline()
        menu.addItem(statusMenuItem)
        
        menu.addItem(NSMenuItem.separator())
        
        // Access Code display
        codeMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        codeMenuItem.isEnabled = false
        setCode("----")
        menu.addItem(codeMenuItem)
        
        // Single clean clickable Bonjour link
        hostLinkMenuItem = NSMenuItem(title: "", action: #selector(openHostURL), keyEquivalent: "")
        setLink("")
        menu.addItem(hostLinkMenuItem)
        
        // Active connected devices tracker
        devicesMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        devicesMenuItem.isEnabled = false
        setDevices("")
        menu.addItem(devicesMenuItem)
        
        menu.addItem(NSMenuItem.separator())
        
        // Start/Stop toggle button
        toggleServerMenuItem = NSMenuItem(title: "", action: #selector(toggleServer), keyEquivalent: "s")
        setToggleState(running: false)
        menu.addItem(toggleServerMenuItem)
        
        // Quit button
        quitMenuItem = NSMenuItem(title: "", action: #selector(quitApp), keyEquivalent: "q")
        setQuitState()
        menu.addItem(quitMenuItem)
        
        statusItem.menu = menu
        
        // Auto-start server
        startServer()
        
        // Poll for updates (using .common mode so timer fires even when menu is open)
        let timer = Timer(timeInterval: 1.0, target: self, selector: #selector(pollSessionInfo), userInfo: nil, repeats: true)
        RunLoop.current.add(timer, forMode: .common)
        pollTimer = timer
    }
    
    // Attributed Text Helper
    func makeAttributed(_ text: String, color: NSColor, size: CGFloat, bold: Bool = false) -> NSAttributedString {
        let font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineSpacing = 2
        
        let attributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: color,
            .font: font,
            .paragraphStyle: paragraphStyle
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
    
    // Status State setters
    func setStatusActive() {
        statusMenuItem.attributedTitle = makeAttributed("Active", color: NSColor.systemGreen, size: 13, bold: true)
        setMenuIcon(statusMenuItem, name: "circle.fill")
    }
    
    func setStatusOffline() {
        statusMenuItem.attributedTitle = makeAttributed("Offline", color: NSColor.systemRed, size: 13, bold: true)
        setMenuIcon(statusMenuItem, name: "circle.fill")
    }
    
    func setStatusBooting() {
        statusMenuItem.attributedTitle = makeAttributed("Connecting...", color: NSColor.systemOrange, size: 13, bold: true)
        setMenuIcon(statusMenuItem, name: "circle.fill")
    }
    
    func setCode(_ code: String) {
        codeMenuItem.attributedTitle = makeAttributed("Code  \(code)", color: NSColor.white, size: 12, bold: true)
        setMenuIcon(codeMenuItem, name: "lock.fill")
    }
    
    func setLink(_ urlStr: String) {
        if urlStr.isEmpty {
            hostLinkMenuItem.attributedTitle = makeAttributed("No link available", color: NSColor.secondaryLabelColor, size: 11)
            hostLinkMenuItem.isEnabled = false
        } else {
            // Trim scheme for simple elegant layout
            let cleanLink = urlStr.replacingOccurrences(of: "http://", with: "")
            hostLinkMenuItem.attributedTitle = makeAttributed(cleanLink, color: NSColor(red: 0.54, green: 0.7, blue: 0.98, alpha: 1.0), size: 11) // #89b4fa
            hostLinkMenuItem.isEnabled = true
        }
        setMenuIcon(hostLinkMenuItem, name: "link")
    }
    
    func setDevices(_ devices: String) {
        let label = devices.isEmpty ? "No devices connected" : devices
        devicesMenuItem.attributedTitle = makeAttributed(label, color: NSColor.secondaryLabelColor, size: 11)
        setMenuIcon(devicesMenuItem, name: "iphone")
    }
    
    func setToggleState(running: Bool) {
        let title = running ? "Stop Server" : "Start Server"
        let color = running ? NSColor.systemRed : NSColor.systemGreen
        toggleServerMenuItem.attributedTitle = makeAttributed(title, color: color, size: 12, bold: true)
        setMenuIcon(toggleServerMenuItem, name: "power")
    }
    
    func setQuitState() {
        quitMenuItem.attributedTitle = makeAttributed("Quit", color: NSColor.secondaryLabelColor, size: 12)
        setMenuIcon(quitMenuItem, name: "xmark")
    }

    func clearServerPipes() {
        serverOutputPipe?.fileHandleForReading.readabilityHandler = nil
        serverErrorPipe?.fileHandleForReading.readabilityHandler = nil
        serverOutputPipe = nil
        serverErrorPipe = nil
    }
    
    @objc func openHostURL() {
        // Open the parsed link
        let title = hostLinkMenuItem.attributedTitle?.string ?? ""
        if !title.isEmpty && title != "No link available" {
            if let url = URL(string: "http://\(title)") {
                NSWorkspace.shared.open(url)
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
                    self.setStatusOffline()
                    self.setCode("----")
                    self.setLink("")
                    self.setDevices("")
                    self.setToggleState(running: false)
                }
            }
            
            do {
                try proc.run()
                serverProcess = proc
                
                setStatusBooting()
                setToggleState(running: true)
            } catch {
                setStatusOffline()
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
            
            setStatusOffline()
            setCode("----")
            setLink("")
            setDevices("")
            setToggleState(running: false)
        }
    }
    
    @objc func toggleServer() {
        if serverProcess != nil {
            stopServer()
        } else {
            startServer()
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
                    if let code = json["code"] as? String {
                        setCode(code)
                    }
                    if let host = json["host"] as? String {
                        setLink(host)
                    }
                    if let devices = json["devices"] as? String {
                        setDevices(devices)
                    }
                    
                    setStatusActive()
                    setToggleState(running: true)
                }
            } catch {}
        } else {
            if let proc = serverProcess, !proc.isRunning {
                stopServer()
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
