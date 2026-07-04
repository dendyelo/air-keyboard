#!/bin/bash

# Change directory to script location
cd "$(dirname "$0")"

# Force include standard macOS binary paths (like Homebrew and /usr/local)
# which are not inherited by default when launched via double-click from Finder GUI
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

echo "=========================================="
echo "Preparing AirKeyboard Server..."
echo "=========================================="

# Check if package.json exists, if not initialize
if [ ! -f package.json ]; then
    echo "Initializing Node.js project..."
    npm init -y > /dev/null
fi

# Check if ws package is installed, if not install it
if [ ! -d node_modules/ws ]; then
    echo "Installing 'ws' (WebSocket) package for ultra-low latency..."
    npm install ws
fi


# Compile Swift helper when missing or when the source changed.
if [ ! -f keyboard-helper ] || [ MacInputInjector.swift -nt keyboard-helper ]; then
    echo "Compiling Swift Helper..."
    swiftc MacInputInjector.swift -o keyboard-helper
    if [ $? -ne 0 ]; then
        echo "Error: Failed to compile MacInputInjector.swift"
        exit 1
    fi
else
    echo "Swift Helper already compiled, skipping compilation to preserve macOS Accessibility..."
fi

echo "Compilation successful!"
echo ""
echo "=========================================="
echo "Starting AirKeyboard Server..."
echo "=========================================="

# Replace this shell with Node so GUI stop/quit signals reach the server directly.
exec node airkeyboard-server.js
