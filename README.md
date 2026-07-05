# AirKeyboard

AirKeyboard turns an iPhone, iPad, or other mobile browser into a local Wi-Fi keyboard and trackpad for macOS. The phone opens a web controller, the Mac runs a small Node.js/WebSocket server, and a native Swift helper injects keyboard and mouse events through macOS CoreGraphics.

<p align="center">
  <img src="assets/menubar-screenshot.png" alt="macOS Menu Bar App" width="35%"/>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/mobile-controller-screenshot.png" alt="Mobile Web Controller" width="30%"/>
</p>

It is useful for headless Mac setups, quick remote input on the same network, or as an emergency keyboard/trackpad when a physical device is unavailable.

## Features

- Browser-based mobile controller, with no iOS app install required.
- Local WebSocket input path for low-latency keyboard and pointer events.
- macOS native input injection through a persistent Swift helper process.
- Trackpad gestures: move pointer, single-finger tap, two-finger right click, and two-finger scroll.
- Dedicated buttons for Esc, Tab, Delete, Space, Enter, and arrow keys.
- Bonjour/local hostname support, plus IP fallback.
- Session pairing with a 4-digit startup code and trusted-device tokens.
- Trusted tokens are stored as hashes on the Mac and ignored by Git.
- Minimal macOS menu bar app that shows the pairing code, copies the mobile URL, and lists active devices.
- Auto port fallback when port `3000` is already in use.

## Requirements

- macOS 10.15 or later.
- Node.js 16 or later.
- Swift compiler (`swiftc`), usually installed with Xcode Command Line Tools.
- A mobile device on the same trusted local network.

## Quick Start

Run AirKeyboard from the repository:

```bash
./start-airkeyboard.sh
```

The script installs the Node dependency if needed, compiles the Swift input helper if needed, and starts the local server. The terminal prints URLs and a pairing code:

```text
AirKeyboard Server is running (HTTP)!
Open browser on your iOS device and go to:
http://192.168.1.15:3000
http://Your-Mac.local:3000

Access Code for this session: 6590
```

Open one of the URLs on your mobile device, enter the 4-digit code, then use the browser page as a keyboard and trackpad.

## Menu Bar App

AirKeyboard can also be packaged as a native macOS menu bar app. The menu bar app starts the server automatically, shows the current access code, copies the mobile URL when clicked, and stops the server when the app quits.

Build the `.app` bundle with the bundled app icon:

```bash
./build-macos-app.sh
```

You can still pass a custom PNG/JPG path to override `assets/app-icon.png`.

Then move the generated `AirKeyboard.app` into `/Applications` if desired. Generated bundles, binaries, session files, and trusted token files are intentionally ignored by Git.

## macOS Accessibility Permission

macOS requires Accessibility permission before an app can post global keyboard and mouse events.

1. Open System Settings.
2. Go to Privacy & Security > Accessibility.
3. Enable the terminal app or `AirKeyboard.app`, depending on how you launch AirKeyboard.

If permission is granted, the server logs show `[Helper] READY`.

## Security Notes

AirKeyboard gives paired devices the ability to control your Mac keyboard and mouse. Use it only on trusted local networks.

- The server is HTTP/WebSocket on the local network, not end-to-end encrypted.
- A new 4-digit pairing code is generated on each server startup.
- Trusted browser tokens are stored in mobile `localStorage`; server-side token records are hashed in `trusted_tokens.txt`.
- Delete `trusted_tokens.txt` to revoke all trusted devices.
- Do not publish generated files such as `AirKeyboard.app`, `keyboard-helper`, `session_info.json`, or `trusted_tokens.txt`.

## How It Works

```mermaid
graph LR
    A["Mobile browser controller"] -->|"WebSocket"| B["airkeyboard-server.js"]
    B -->|"stdin commands"| C["MacInputInjector.swift"]
    C -->|"CGEvent"| D["macOS keyboard/mouse"]
    E["MenuBarApp.swift"] -->|"launches"| B
```

1. `public/mobile-controller.js` captures text input, button presses, and trackpad gestures in the mobile browser.
2. `airkeyboard-server.js` serves the controller, authenticates clients, validates input messages, and forwards commands to the helper.
3. `MacInputInjector.swift` reads commands from stdin and posts native macOS keyboard/mouse events.
4. `MenuBarApp.swift` provides the optional native menu bar launcher and status UI.

## Project Files

- `airkeyboard-server.js` - local HTTP/WebSocket server and authentication layer.
- `public/index.html` - browser entry point for the mobile controller.
- `public/mobile-controller.js` - mobile keyboard and trackpad interaction logic.
- `public/mobile-controller.css` - mobile controller UI styling.
- `assets/app-icon.png` - source image used for the generated macOS app icon.
- `MacInputInjector.swift` - native macOS keyboard/mouse event injector.
- `MenuBarApp.swift` - native macOS menu bar app.
- `start-airkeyboard.sh` - local startup script.
- `build-macos-app.sh` - native `.app` bundle builder.

## Development

Run syntax checks:

```bash
npm test
```

Compile Swift files manually:

```bash
npm run build:helper
npm run build:gui
```

## License

MIT. See [LICENSE](LICENSE).
