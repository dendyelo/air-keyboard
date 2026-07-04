const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');

const START_PORT = 3000;

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
const accessCode = Math.floor(1000 + Math.random() * 9000).toString();

// Load trusted tokens
const tokensPath = path.join(__dirname, 'trusted_tokens.txt');
let trustedTokens = new Set();
if (fs.existsSync(tokensPath)) {
  const data = fs.readFileSync(tokensPath, 'utf8');
  trustedTokens = new Set(data.split('\n').map(t => t.trim()).filter(Boolean));
}

// Function to trust a new token
function addTrustedToken(token) {
  trustedTokens.add(token);
  fs.writeFileSync(tokensPath, Array.from(trustedTokens).join('\n') + '\n', 'utf8');
}

// Start helper process
const helperPath = path.join(__dirname, 'keyboard-helper');
if (!fs.existsSync(helperPath)) {
  console.error(`Error: ${helperPath} not found. Please compile it first!`);
  process.exit(1);
}

const helper = spawn(helperPath);

helper.stdout.on('data', (data) => {
  const msg = data.toString().trim();
  console.log(`[Helper] ${msg}`);
});

helper.stderr.on('data', (data) => {
  console.error(`[Helper Error] ${data.toString().trim()}`);
});

helper.on('close', (code) => {
  console.log(`Helper process exited with code ${code}`);
  process.exit(code);
});

// Simple HTTP server for public files
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);

  const extname = path.extname(filePath);
  let contentType = 'text/html';
  switch (extname) {
    case '.js': contentType = 'text/javascript'; break;
    case '.css': contentType = 'text/css'; break;
    case '.json': contentType = 'application/json'; break;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// Helper to determine device type and IP
function getDeviceLabel(req) {
  const ip = req.socket.remoteAddress.replace(/^.*:/, '') || 'Unknown IP';
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
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const deviceLabel = getDeviceLabel(req);
  ws.deviceLabel = deviceLabel;
  ws.authenticated = false;

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
      if (trimmed.startsWith('AUTH_TOKEN:')) {
        const token = trimmed.substring(11).trim();
        if (trustedTokens.has(token)) {
          ws.authenticated = true;
          clearTimeout(authTimeout);
          ws.send('AUTH_OK');
          console.log(`[Success] ${deviceLabel} authenticated via trusted token.`);
          broadcastActiveDevices();
        } else {
          ws.send('AUTH_FAIL');
          console.log(`[Fail] ${deviceLabel} sent invalid token.`);
          ws.close();
        }
      } else if (trimmed.startsWith('AUTH_CODE:')) {
        const code = trimmed.substring(10).trim();
        if (code === accessCode) {
          ws.authenticated = true;
          clearTimeout(authTimeout);
          
          // Generate a long trust token for this device
          const newTrustToken = crypto.randomBytes(24).toString('hex');
          addTrustedToken(newTrustToken);
          
          ws.send(`AUTH_OK:${newTrustToken}`);
          console.log(`[Success] ${deviceLabel} authenticated with Access Code. Device is now trusted.`);
          broadcastActiveDevices();
        } else {
          ws.send('AUTH_FAIL');
          console.log(`[Fail] ${deviceLabel} sent incorrect Access Code.`);
          ws.close();
        }
      } else {
        ws.send('AUTH_FAIL');
        ws.close();
      }
      return;
    }

    // Forward raw keystroke/mouse action (including spaces) to Swift helper
    helper.stdin.write(data + '\n');
  });

  ws.on('close', () => {
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
process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

// Start listening with Auto Port Detection
let currentPort = START_PORT;
function startListening() {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${currentPort} is busy, trying port ${currentPort + 1}...`);
      currentPort++;
      startListening();
    } else {
      console.error('Server error:', err);
    }
  });

  server.listen(currentPort, '0.0.0.0', () => {
    const hostUrl = localHostname ? `http://${localHostname}:${currentPort}` : `http://${localIp}:${currentPort}`;
    console.log(`\n==========================================`);
    console.log(`AirKeyboard Server is running (HTTP)!`);
    console.log(`Open browser on your iOS device and go to:`);
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
