const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');

const START_PORT = 3000;
const LISTEN_HOST = process.env.AIRKEYBOARD_HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const TOKEN_PREFIX = 'sha256:';
const MAX_AUTH_FAILURES = 5;
const AUTH_LOCK_MS = 60 * 1000;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_MOUSE_DELTA = 500;
const MAX_SCROLL_DELTA = 1000;
const ALLOWED_KEYS = new Set([
  'backspace',
  'delete',
  'enter',
  'return',
  'space',
  'up',
  'down',
  'left',
  'right',
  'tab',
  'escape',
  'esc'
]);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};
const authFailures = new Map();

// Find local IP address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const localIp = getLocalIp();

// Get local macOS hostname (Bonjour / mDNS)
let localHostname = '';
try {
  localHostname = execSync('scutil --get LocalHostName').toString().trim() + '.local';
} catch (e) {
  localHostname = '';
}

// Generate a random 4-digit Access Code for this boot/session
const accessCode = crypto.randomInt(1000, 10000).toString();

// Load trusted tokens
const tokensPath = path.join(__dirname, 'trusted_tokens.txt');
let trustedTokens = new Set();

function hashToken(token) {
  return TOKEN_PREFIX + crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqualString(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function persistTrustedTokens() {
  fs.writeFileSync(tokensPath, Array.from(trustedTokens).join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    fs.chmodSync(tokensPath, 0o600);
  } catch (e) {}
}

function loadTrustedTokens() {
  const tokens = new Set();
  let migratedLegacyTokens = false;

  if (!fs.existsSync(tokensPath)) {
    return tokens;
  }

  const data = fs.readFileSync(tokensPath, 'utf8');
  for (const rawLine of data.split('\n')) {
    const token = rawLine.trim();
    if (!token) continue;

    if (token.startsWith(TOKEN_PREFIX)) {
      tokens.add(token);
    } else {
      tokens.add(hashToken(token));
      migratedLegacyTokens = true;
    }
  }

  if (migratedLegacyTokens) {
    trustedTokens = tokens;
    persistTrustedTokens();
  }

  return tokens;
}

trustedTokens = loadTrustedTokens();

// Function to trust a new token
function addTrustedToken(token) {
  trustedTokens.add(hashToken(token));
  persistTrustedTokens();
}

function isTrustedToken(token) {
  if (!/^[a-f0-9]{48,128}$/i.test(token)) {
    return false;
  }

  const candidate = hashToken(token);
  for (const trustedToken of trustedTokens) {
    if (safeEqualString(candidate, trustedToken)) {
      return true;
    }
  }
  return false;
}

function getRemoteIp(req) {
  return (req.socket.remoteAddress || '').replace(/^.*:/, '') || 'Unknown IP';
}

function getAuthFailureState(ip) {
  const now = Date.now();
  const state = authFailures.get(ip);
  if (!state) {
    return { count: 0, lockedUntil: 0 };
  }

  if (state.lockedUntil && state.lockedUntil <= now) {
    authFailures.delete(ip);
    return { count: 0, lockedUntil: 0 };
  }

  return state;
}

function isAuthLocked(ip) {
  return getAuthFailureState(ip).lockedUntil > Date.now();
}

function recordAuthFailure(ip) {
  const state = getAuthFailureState(ip);
  const count = state.count + 1;
  const lockedUntil = count >= MAX_AUTH_FAILURES ? Date.now() + AUTH_LOCK_MS : 0;
  authFailures.set(ip, { count, lockedUntil });
  return lockedUntil > 0;
}

function resetAuthFailures(ip) {
  authFailures.delete(ip);
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return true;

  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch (e) {
    return false;
  }
}

// Start helper process
const helperPath = path.join(__dirname, 'keyboard-helper');
if (!fs.existsSync(helperPath)) {
  console.error(`Error: ${helperPath} not found. Please compile it first!`);
  process.exit(1);
}

let isShuttingDown = false;
const helper = spawn(helperPath);

helper.on('error', (err) => {
  if (isShuttingDown) return;
  console.error(`[Helper Error] Failed to start helper: ${err.message}`);
  process.exit(1);
});

helper.stdout.on('data', (data) => {
  const msg = data.toString().trim();
  console.log(`[Helper] ${msg}`);
});

helper.stderr.on('data', (data) => {
  console.error(`[Helper Error] ${data.toString().trim()}`);
});

helper.stdin.on('error', (err) => {
  if (!isShuttingDown) {
    console.error(`[Helper Stdin Error] ${err.message}`);
  }
});

helper.on('close', (code) => {
  if (isShuttingDown) return;
  console.log(`Helper process exited with code ${code}`);
  process.exit(code);
});

// Simple HTTP server for public files
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Allow': 'GET, HEAD'
    });
    res.end('Method Not Allowed');
    return;
  }

  let filePath;
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
    filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    fs.readFile(filePath, (error, content) => {
      if (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Server Error: ${error.code}`);
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(content);
        }
      }
    });
  });
});

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function writeHelperLine(line) {
  if (!helper.stdin.destroyed) {
    helper.stdin.write(line + '\n');
  }
}

function forwardInputCommand(data) {
  if (Buffer.byteLength(data, 'utf8') > MAX_TEXT_BYTES + 32) {
    return false;
  }

  if (data.startsWith('KEY:')) {
    const key = data.slice(4).trim().toLowerCase();
    if (!ALLOWED_KEYS.has(key)) {
      return false;
    }

    writeHelperLine(`KEY:${key}`);
    return true;
  }

  if (data.startsWith('TXT:')) {
    const text = data.slice(4);
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      return false;
    }

    writeHelperLine(`TXT64:${Buffer.from(text, 'utf8').toString('base64')}`);
    return true;
  }

  if (!data.startsWith('MSE:')) {
    return false;
  }

  const command = data.slice(4).trim();
  if (command === 'click' || command === 'rclick') {
    writeHelperLine(`MSE:${command}`);
    return true;
  }

  if (command.startsWith('move:')) {
    const coords = command.slice(5).split(',');
    if (coords.length !== 2) return false;

    const dx = Number(coords[0]);
    const dy = Number(coords[1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;

    const limitedDx = clamp(dx, -MAX_MOUSE_DELTA, MAX_MOUSE_DELTA);
    const limitedDy = clamp(dy, -MAX_MOUSE_DELTA, MAX_MOUSE_DELTA);
    writeHelperLine(`MSE:move:${limitedDx.toFixed(1)},${limitedDy.toFixed(1)}`);
    return true;
  }

  if (command.startsWith('scroll:')) {
    const parts = command.slice(7).split(',');
    if (parts.length === 2) {
      const dy = Number(parts[0]);
      const dx = Number(parts[1]);
      if (Number.isFinite(dy) && Number.isFinite(dx)) {
        writeHelperLine(`MSE:scroll:${Math.round(clamp(dy, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA))},${Math.round(clamp(dx, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA))}`);
        return true;
      }
    } else {
      const dy = Number(parts[0]);
      if (Number.isFinite(dy)) {
        writeHelperLine(`MSE:scroll:${Math.round(clamp(dy, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA))}`);
        return true;
      }
    }
    return false;
  }

  if (command.startsWith('zoom:')) {
    const val = Number(command.slice(5));
    if (Number.isFinite(val)) {
      writeHelperLine(`MSE:zoom:${Math.round(clamp(val, -100, 100))}`);
      return true;
    }
    return false;
  }

  return false;
}

function failAuthentication(ws, ip, deviceLabel, reason, errorType = 'AUTH_FAIL') {
  const locked = recordAuthFailure(ip);
  ws.send(locked ? 'AUTH_LOCKED' : errorType);
  console.log(`[Fail] ${deviceLabel} ${reason}${locked ? ' IP temporarily locked.' : ''}`);
  ws.close();
}

function authenticateWithToken(ws, ip, deviceLabel, token) {
  if (isTrustedToken(token)) {
    ws.authenticated = true;
    resetAuthFailures(ip);
    ws.send('AUTH_OK');
    console.log(`[Success] ${deviceLabel} authenticated via trusted token.`);
    broadcastActiveDevices();
  } else {
    failAuthentication(ws, ip, deviceLabel, 'sent invalid token.', 'AUTH_TOKEN_FAIL');
  }
}

function authenticateWithCode(ws, ip, deviceLabel, code) {
  if (/^\d{4}$/.test(code) && safeEqualString(code, accessCode)) {
    ws.authenticated = true;
    resetAuthFailures(ip);

    // Generate a long trust token for this device
    const newTrustToken = crypto.randomBytes(32).toString('hex');
    addTrustedToken(newTrustToken);

    ws.send(`AUTH_OK:${newTrustToken}`);
    console.log(`[Success] ${deviceLabel} authenticated with Access Code. Device is now trusted.`);
    broadcastActiveDevices();
  } else {
    failAuthentication(ws, ip, deviceLabel, 'sent incorrect Access Code.', 'AUTH_FAIL');
  }
}

// Helper to determine device type and IP
function getDeviceLabel(req) {
  const ip = getRemoteIp(req);
  const userAgent = req.headers['user-agent'] || '';
  let deviceType = 'Mobile Device';
  
  if (/ipad/i.test(userAgent)) {
    deviceType = 'iPad';
  } else if (/iphone/i.test(userAgent)) {
    deviceType = 'iPhone';
  } else if (/android/i.test(userAgent)) {
    deviceType = 'Android';
  } else if (/macintosh/i.test(userAgent)) {
    deviceType = 'Mac';
  } else if (/windows/i.test(userAgent)) {
    deviceType = 'Windows PC';
  }
  
  return `${deviceType} (${ip})`;
}

// Function to broadcast list of active devices to all clients
function broadcastActiveDevices() {
  const activeDevices = [];
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.authenticated) {
      activeDevices.push(client.deviceLabel);
    }
  });
  
  const devicesList = activeDevices.join(', ');
  const msg = `DEVICES:${devicesList}`;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.authenticated) {
      client.send(msg);
    }
  });

  // Update session_info.json so the Swift GUI knows about connected devices
  try {
    const sessionPath = path.join(__dirname, 'session_info.json');
    if (fs.existsSync(sessionPath)) {
      const data = fs.readFileSync(sessionPath, 'utf8');
      const sessionInfo = JSON.parse(data);
      sessionInfo.devices = devicesList;
      fs.writeFileSync(sessionPath, JSON.stringify(sessionInfo), 'utf8');
    }
  } catch (e) {
    console.error('Failed to update session_info.json with device list:', e);
  }
}

// Create WebSocket server
const wss = new WebSocket.Server({ server, maxPayload: MAX_TEXT_BYTES + 1024 });

wss.on('error', (err) => {
  if (!isShuttingDown) {
    console.error('WebSocket server error:', err);
  }
});

wss.on('connection', (ws, req) => {
  const ip = getRemoteIp(req);
  const deviceLabel = getDeviceLabel(req);
  ws.deviceLabel = deviceLabel;
  ws.authenticated = false;

  if (!isAllowedOrigin(req)) {
    console.log(`[Rejected] ${deviceLabel} used an unexpected WebSocket origin.`);
    ws.send('AUTH_FAIL');
    ws.close();
    return;
  }

  if (isAuthLocked(ip)) {
    console.log(`[Rejected] ${deviceLabel} is temporarily locked after too many failed attempts.`);
    ws.send('AUTH_LOCKED');
    ws.close();
    return;
  }

  console.log(`New connection established from ${deviceLabel}. Awaiting authentication...`);

  // Disconnect if authentication takes too long (30 seconds for comfortable human entry)
  const authTimeout = setTimeout(() => {
    if (!ws.authenticated) {
      console.log(`Authentication timeout for ${deviceLabel}. Closing connection.`);
      ws.send('AUTH_FAIL');
      ws.close();
    }
  }, 30000);

  ws.on('message', (message) => {
    const data = message.toString();

    if (!ws.authenticated) {
      const trimmed = data.trim();
      if (trimmed.length > 256) {
        failAuthentication(ws, ip, deviceLabel, 'sent an oversized auth message.');
        return;
      }

      if (trimmed.startsWith('AUTH_TOKEN:')) {
        const token = trimmed.substring(11).trim();
        authenticateWithToken(ws, ip, deviceLabel, token);
        if (ws.authenticated) clearTimeout(authTimeout);
      } else if (trimmed.startsWith('AUTH_CODE:')) {
        const code = trimmed.substring(10).trim();
        authenticateWithCode(ws, ip, deviceLabel, code);
        if (ws.authenticated) clearTimeout(authTimeout);
      } else {
        failAuthentication(ws, ip, deviceLabel, 'sent an unknown auth message.');
      }
      return;
    }

    if (!forwardInputCommand(data)) {
      console.log(`[Rejected] ${deviceLabel} sent an invalid input command.`);
      ws.close(1008, 'Invalid command');
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (ws.authenticated) {
      console.log(`[Disconnected] ${deviceLabel}`);
      broadcastActiveDevices();
    }
  });
});

// Clean up files on exit
function cleanup() {
  try {
    fs.unlinkSync(path.join(__dirname, 'session_info.json'));
  } catch (e) {}
}
process.on('exit', cleanup);

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  cleanup();

  wss.clients.forEach((client) => client.close());
  server.close(() => process.exit(0));

  if (!helper.killed) {
    helper.kill();
  }

  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function fatalStartupError(err) {
  console.error('Server error:', err);
  isShuttingDown = true;
  cleanup();
  if (!helper.killed) {
    helper.kill();
  }
  process.exit(1);
}

// Start listening with Auto Port Detection
let currentPort = START_PORT;
function startListening() {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${currentPort} is busy, trying port ${currentPort + 1}...`);
      currentPort++;
      startListening();
    } else {
      fatalStartupError(err);
    }
  });

  server.listen(currentPort, LISTEN_HOST, () => {
    const hostUrl = localHostname ? `http://${localHostname}:${currentPort}` : `http://${localIp}:${currentPort}`;
    console.log(`\n==========================================`);
    console.log(`AirKeyboard Server is running (HTTP)!`);
    console.log(`Open browser on your mobile device and go to:`);
    console.log(`👉 http://${localIp}:${currentPort}`);
    if (localHostname) {
      console.log(`👉 ${hostUrl}`);
    }
    console.log(`------------------------------------------`);
    console.log(`Access Code for this session: ${accessCode}`);
    console.log(`==========================================\n`);

    // Write session info to JSON for launcher notifications
    const sessionInfo = {
      ip: `http://${localIp}:${currentPort}`,
      host: hostUrl,
      code: accessCode
    };
    fs.writeFileSync(path.join(__dirname, 'session_info.json'), JSON.stringify(sessionInfo), 'utf8');
  });
}

startListening();
