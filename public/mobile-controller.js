let ws;
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const liveInput = document.getElementById('liveInput');
const touchpad = document.getElementById('touchpad');
const leftClickBtn = document.getElementById('leftClickBtn');
const rightClickBtn = document.getElementById('rightClickBtn');

const authOverlay = document.getElementById('authOverlay');
const accessCodeInput = document.getElementById('accessCodeInput');
const authBtn = document.getElementById('authBtn');
const authError = document.getElementById('authError');

const sensitivityRange = document.getElementById('sensitivityRange');
const sensitivityVal = document.getElementById('sensitivityVal');

const defaultValue = " ";

// Initialize Live Input with default space value
liveInput.value = defaultValue;

// Pointer Sensitivity configuration
let mouseSensitivity = parseFloat(localStorage.getItem('airkeyboard_sensitivity') || '3.0');
sensitivityRange.value = mouseSensitivity;
sensitivityVal.textContent = mouseSensitivity.toFixed(1);

sensitivityRange.addEventListener('input', (e) => {
    mouseSensitivity = parseFloat(e.target.value);
    sensitivityVal.textContent = mouseSensitivity.toFixed(1);
    localStorage.setItem('airkeyboard_sensitivity', mouseSensitivity.toString());
});

// Establish WebSocket connection
function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        statusDot.className = 'dot connected';
        statusText.textContent = 'Connected';
        console.log('Connected to Mac');
        
        // Check if we already have a trusted session token
        const savedToken = localStorage.getItem('airkeyboard_token');
        if (savedToken) {
            send(`AUTH_TOKEN:${savedToken}`);
        } else {
            showAuthOverlay();
        }
    };
    
    ws.onclose = () => {
        statusDot.className = 'dot disconnected';
        statusText.textContent = 'Disconnected';
        console.log('Disconnected. Retrying in 2s...');
        setTimeout(connect, 2000);
    };
    
    ws.onmessage = (event) => {
        const msg = event.data.trim();
        if (msg.startsWith('AUTH_OK')) {
            if (msg.includes(':')) {
                // First pairing: server generated a new trust token
                const newToken = msg.split(':')[1];
                localStorage.setItem('airkeyboard_token', newToken);
            }
            hideAuthOverlay();
        } else if (msg === 'AUTH_TOKEN_FAIL') {
            localStorage.removeItem('airkeyboard_token');
            showAuthOverlay();
            authError.textContent = ""; // Silent prompt (no error message yet)
        } else if (msg === 'AUTH_FAIL') {
            localStorage.removeItem('airkeyboard_token');
            accessCodeInput.value = ""; // Clear incorrect code on failure
            showAuthOverlay();
            authError.textContent = "Incorrect Access Code. Try again.";
        } else if (msg === 'AUTH_LOCKED') {
            localStorage.removeItem('airkeyboard_token');
            accessCodeInput.value = "";
            showAuthOverlay();
            authError.textContent = "Too many attempts. Wait a minute, then try again.";
        } else if (msg.startsWith('DEVICES:')) {
            const list = msg.substring(8).trim();
            document.getElementById('connectedDevices').textContent = list ? `Active: ${list}` : 'Active: None';
        }
    };
    
    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

// Access Code Overlay Handlers
function showAuthOverlay() {
    authOverlay.classList.add('active');
    accessCodeInput.focus();
}

function hideAuthOverlay() {
    authOverlay.classList.remove('active');
    liveInput.focus();
}

// Verification submit
function submitVerification() {
    const code = accessCodeInput.value.trim();
    if (code.length === 4) {
        authError.textContent = "";
        send(`AUTH_CODE:${code}`);
    } else {
        authError.textContent = "Please enter a 4-digit code.";
    }
}

authBtn.addEventListener('click', submitVerification);
accessCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        submitVerification();
    }
});

// Send command to server
function send(command) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(command);
        triggerPulse();
    }
}

// Flash status indicator on transmission
function triggerPulse() {
    statusDot.classList.remove('pulse');
    void statusDot.offsetWidth; // Force reflow
    statusDot.classList.add('pulse');
}

// Live Input Event Listener (Char-by-char)
liveInput.addEventListener('input', (e) => {
    const val = liveInput.value;
    
    if (val.length === 0) {
        // Backspace was pressed (value went from " " to "")
        send('KEY:backspace');
        triggerHaptic();
        liveInput.value = defaultValue;
    } else if (val.length > 1) {
        // Character(s) added
        const typed = val.slice(1);
        if (typed === '\n') {
            send('KEY:enter');
        } else {
            send(`TXT:${typed}`);
        }
        triggerHaptic();
        
        // Reset to default value
        liveInput.value = defaultValue;
    }
});

// Keydown failsafe
liveInput.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') {
        send('KEY:backspace');
        triggerHaptic();
        e.preventDefault();
    }
});

// Key Repeat (Hold-to-Repeat) Logic for Navigation & Backspace
let repeatTimeout;
let repeatInterval;

function startRepeat(key) {
    stopRepeat();
    send(`KEY:${key}`);
    triggerHaptic();
    
    // Keys allowed to auto-repeat
    const repeatableKeys = ['backspace', 'space', 'enter', 'up', 'down', 'left', 'right', 'tab'];
    if (!repeatableKeys.includes(key.toLowerCase())) return;
    
    // 400ms delay before repeat, then repeating every 80ms
    repeatTimeout = setTimeout(() => {
        repeatInterval = setInterval(() => {
            send(`KEY:${key}`);
            triggerHaptic();
        }, 80);
    }, 400);
}

// Stop key repeat
function stopRepeat() {
    clearTimeout(repeatTimeout);
    clearInterval(repeatInterval);
}

// Keyboard Buttons / D-Pad listener with hold-to-repeat
document.querySelectorAll('.key-btn').forEach(button => {
    const key = button.getAttribute('data-key');
    if (!key) return;
    
    // Touch interface
    button.addEventListener('touchstart', (e) => {
        e.preventDefault(); // Prevents touch-to-mouse emulation delay
        startRepeat(key);
    });
    
    button.addEventListener('touchend', (e) => {
        e.preventDefault();
        stopRepeat();
    });
    
    button.addEventListener('touchcancel', (e) => {
        stopRepeat();
    });
    
    // Mouse fallback
    button.addEventListener('mousedown', (e) => {
        if ('ontouchstart' in window) return; // Ignore if mobile touch is active
        startRepeat(key);
    });
    
    button.addEventListener('mouseup', () => {
        stopRepeat();
    });
    
    button.addEventListener('mouseleave', () => {
        stopRepeat();
    });
});

// Simple Haptic Feedback simulation
function triggerHaptic(strong = false) {
    if (navigator.vibrate) {
        navigator.vibrate(strong ? [30, 30, 30] : 10);
    }
}

// Remote Touchpad / Trackpad Gesture logic
let lastX = 0;
let lastY = 0;
let lastScrollY = 0;
let isMultiTouch = false;
let multiTouchMoved = false;
let touchStartX = 0;
let touchStartY = 0;
let touchStartCenterY = 0;
let touchStartTime = 0;
let initialPinchDistance = 0;
let lastZoomTime = 0;


touchpad.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches;
    touchStartTime = Date.now();
    
    if (t.length === 1) {
        isMultiTouch = false;
        multiTouchMoved = false;
        lastX = t[0].clientX;
        lastY = t[0].clientY;
        touchStartX = t[0].clientX;
        touchStartY = t[0].clientY;
    } else if (t.length === 2) {
        isMultiTouch = true;
        multiTouchMoved = false;
        lastScrollY = (t[0].clientY + t[1].clientY) / 2;
        touchStartCenterY = lastScrollY;
        initialPinchDistance = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    }
});

touchpad.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const t = e.touches;
    
    if (t.length === 1 && !isMultiTouch) {
        const dx = t[0].clientX - lastX;
        const dy = t[0].clientY - lastY;
        
        // Calculate velocity (distance traveled in this touchmove event)
        const dist = Math.hypot(dx, dy);
        
        // Dynamic acceleration: faster swipes multiply the movement range
        const acceleration = 1 + (dist * 0.04);
        
        const finalDx = dx * mouseSensitivity * acceleration;
        const finalDy = dy * mouseSensitivity * acceleration;
        
        send(`MSE:move:${finalDx.toFixed(1)},${finalDy.toFixed(1)}`);
        
        lastX = t[0].clientX;
        lastY = t[0].clientY;
    } else if (t.length === 2) {
        const currentPinchDistance = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
        
        // Check if the fingers are pinching (distance changed significantly)
        if (initialPinchDistance > 0 && Math.abs(currentPinchDistance - initialPinchDistance) > 12) {
            const now = Date.now();
            if (now - lastZoomTime > 140) { // Throttle to prevent event queue lag
                const ratio = currentPinchDistance / initialPinchDistance;
                if (ratio > 1.06) {
                    send('MSE:zoom:1'); // Zoom In (Cmd + =)
                    initialPinchDistance = currentPinchDistance;
                    lastZoomTime = now;
                    multiTouchMoved = true;
                } else if (ratio < 0.94) {
                    send('MSE:zoom:-1'); // Zoom Out (Cmd + -)
                    initialPinchDistance = currentPinchDistance;
                    lastZoomTime = now;
                    multiTouchMoved = true;
                }
            }
        } else {
            // Otherwise treat as standard 2-finger scroll
            const currentScrollY = (t[0].clientY + t[1].clientY) / 2;
            const dy = currentScrollY - lastScrollY;
            if (Math.abs(currentScrollY - touchStartCenterY) > 8) {
                multiTouchMoved = true;
            }
            
            // Scroll speed multiplier (reversed direction to match standard Apple Natural Scroll)
            const scrollSensitivity = 1.6;
            send(`MSE:scroll:${Math.round(-dy * scrollSensitivity)},0`);
            
            lastScrollY = currentScrollY;
        }
    }
});

touchpad.addEventListener('touchend', (e) => {
    e.preventDefault();
    
    const duration = Date.now() - touchStartTime;
    if (duration < 250) {
        if (!isMultiTouch) {
            // Short tap with 1 finger = Left Click
            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const dist = Math.hypot(endX - touchStartX, endY - touchStartY);
            if (dist < 8) {
                send('MSE:click');
                triggerHaptic();
            }
        } else if (!multiTouchMoved) {
            // Short tap with 2 fingers = Right Click
            send('MSE:rclick');
            triggerHaptic(true);
        }
    }
});

// Dedicated Click Buttons listeners
leftClickBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    send('MSE:click');
    triggerHaptic();
});
leftClickBtn.addEventListener('mousedown', (e) => {
    if ('ontouchstart' in window) return;
    send('MSE:click');
    triggerHaptic();
});

rightClickBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    send('MSE:rclick');
    triggerHaptic(true);
});
rightClickBtn.addEventListener('mousedown', (e) => {
    if ('ontouchstart' in window) return;
    send('MSE:rclick');
    triggerHaptic(true);
});

// 1-Finger Scrollbars
const scrollBarY = document.getElementById('scrollBarY');
const scrollBarX = document.getElementById('scrollBarX');
let lastScrollYTouch = 0;
let lastScrollXTouch = 0;

scrollBarY.addEventListener('touchstart', (e) => {
    e.preventDefault();
    lastScrollYTouch = e.touches[0].clientY;
    triggerHaptic();
});

scrollBarY.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const currentY = e.touches[0].clientY;
    const dy = currentY - lastScrollYTouch;
    
    const scrollSensitivity = 1.6;
    send(`MSE:scroll:${Math.round(-dy * scrollSensitivity)},0`);
    
    lastScrollYTouch = currentY;
});

scrollBarX.addEventListener('touchstart', (e) => {
    e.preventDefault();
    lastScrollXTouch = e.touches[0].clientX;
    triggerHaptic();
});

scrollBarX.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const currentX = e.touches[0].clientX;
    const dx = currentX - lastScrollXTouch;
    
    const scrollSensitivity = 1.6;
    send(`MSE:scroll:0,${Math.round(-dx * scrollSensitivity)}`);
    
    lastScrollXTouch = currentX;
});

// Start Connection
connect();
