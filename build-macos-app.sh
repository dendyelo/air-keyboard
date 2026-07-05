#!/bin/bash

# Change directory to script location
cd "$(dirname "$0")"

echo "=========================================="
echo "Building Native SwiftUI/AppKit AirKeyboard.app..."
echo "=========================================="

# Define paths
APP_NAME="AirKeyboard.app"
CONTENTS_DIR="$APP_NAME/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
APP_SOURCE_DIR="$RESOURCES_DIR/app"
DEFAULT_ICON_PATH="assets/app-icon.png"

# Image input path (passed as argument, or default project icon)
INPUT_IMAGE="${1:-$DEFAULT_ICON_PATH}"

if [ -z "$INPUT_IMAGE" ]; then
    echo "Error: Please specify the path to the app icon image."
    echo "Usage: ./build-macos-app.sh [path_to_png_or_jpg]"
    exit 1
fi

if [ ! -f "$INPUT_IMAGE" ]; then
    echo "Error: Image file not found at '$INPUT_IMAGE'"
    echo "Usage: ./build-macos-app.sh [path_to_png_or_jpg]"
    exit 1
fi

# 1. Clean previous builds
rm -rf "$APP_NAME"
rm -rf AppIcon.iconset

# 2. Create directory structure
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"
mkdir -p "$APP_SOURCE_DIR"

# 3. Copy all source files (except the GUI code itself) to self-contained app resources
echo "Copying source files to App resources..."
cp -R public "$APP_SOURCE_DIR/"
cp airkeyboard-server.js "$APP_SOURCE_DIR/"
cp MacInputInjector.swift "$APP_SOURCE_DIR/"
cp start-airkeyboard.sh "$APP_SOURCE_DIR/"
cp package.json "$APP_SOURCE_DIR/"

# Pre-compile the Swift helper binary so it doesn't re-compile and trigger macOS Accessibility warnings
echo "Pre-compiling Swift Helper for the App bundle..."
swiftc MacInputInjector.swift -o "$APP_SOURCE_DIR/keyboard-helper"
if [ $? -ne 0 ]; then
    echo "Error: Failed to compile MacInputInjector.swift for App bundle"
    exit 1
fi
chmod +x "$APP_SOURCE_DIR/keyboard-helper"

if [ -f package-lock.json ]; then
    cp package-lock.json "$APP_SOURCE_DIR/"
fi

# Copy node_modules to avoid redownloading
if [ -d node_modules ]; then
    echo "Copying node_modules to avoid redownloading..."
    cp -R node_modules "$APP_SOURCE_DIR/"
fi

# 4. Generate AppIcon.icns
echo "Generating macOS AppIcon.icns..."
ICONSET_DIR="AppIcon.iconset"
mkdir -p "$ICONSET_DIR"

# Generate required icon dimensions
sips -s format png -z 16 16     "$INPUT_IMAGE" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null 2>&1
sips -s format png -z 32 32     "$INPUT_IMAGE" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null 2>&1
sips -s format png -z 32 32     "$INPUT_IMAGE" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null 2>&1
sips -s format png -z 64 64     "$INPUT_IMAGE" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null 2>&1
sips -s format png -z 128 128   "$INPUT_IMAGE" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null 2>&1
sips -s format png -z 256 256   "$INPUT_IMAGE" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null 2>&1
sips -s format png -z 256 256   "$INPUT_IMAGE" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null 2>&1
sips -s format png -z 512 512   "$INPUT_IMAGE" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null 2>&1
sips -s format png -z 512 512   "$INPUT_IMAGE" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null 2>&1
sips -s format png -z 1024 1024 "$INPUT_IMAGE" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null 2>&1

# Convert iconset directory to standard icns file
iconutil -c icns "$ICONSET_DIR" --o "$RESOURCES_DIR/AppIcon.icns"
rm -rf "$ICONSET_DIR"

echo "Icon generated successfully!"

# 5. Create Info.plist
echo "Creating Info.plist..."
cat <<EOF > "$CONTENTS_DIR/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>English</string>
    <key>CFBundleExecutable</key>
    <string>AirKeyboard</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>com.wildan.airkeyboard</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>AirKeyboard</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
EOF

# 6. Compile MenuBarApp.swift directly as the native application executable
echo "Compiling MenuBarApp.swift native App..."
SDK_PATH=$(xcrun --show-sdk-path --sdk macosx)
swiftc -sdk "$SDK_PATH" MenuBarApp.swift -o "$MACOS_DIR/AirKeyboard"

if [ $? -ne 0 ]; then
    echo "Error: Failed to compile MenuBarApp.swift"
    exit 1
fi

# 7. Apply deep ad-hoc codesign to the entire app bundle
# This is critical for macOS to preserve Accessibility permissions across launches
echo "Deep-signing the application bundle..."
codesign --force --deep --sign - "$APP_NAME"

chmod +x "$MACOS_DIR/AirKeyboard"
chmod +x "$APP_SOURCE_DIR/start-airkeyboard.sh"

echo "=========================================="
echo "BUILD SUCCESSFUL: Native GUI AirKeyboard.app created!"
echo "You can now drag this app to your /Applications folder."
echo "=========================================="
