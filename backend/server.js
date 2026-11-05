import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to compiled frontend dist directory
const distCandidates = [
  path.resolve(__dirname, '../frontend/dist'),
  path.resolve(__dirname, '../dist'),
  path.resolve(__dirname, './dist'),
  path.resolve(process.cwd(), 'frontend/dist'),
  path.resolve(process.cwd(), 'dist')
];
const DIST_PATH = distCandidates.find(p => fs.existsSync(p)) || null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
};

const PORT = process.env.PORT || 8443;

// Multi-token auth: accept process.env.RELAY_TOKEN, 'saeindia_sec_99348a7b1c0e', and 'saeindia_secret_token_2026'
function getAllowedTokens() {
  const tokens = new Set([
    'saeindia_sec_99348a7b1c0e',
    'saeindia_secret_token_2026'
  ]);
  if (process.env.RELAY_TOKEN && process.env.RELAY_TOKEN.trim()) {
    tokens.add(process.env.RELAY_TOKEN.trim());
  }
  return tokens;
}

function isValidToken(token) {
  if (!token || typeof token !== 'string') return false;
  const clean = token.trim().replace(/^["']|["']$/g, '');
  return getAllowedTokens().has(clean);
}

// Global relay state
let connectorSocket = null;
let esp32Online = false;
let esp32Baud = 57600;
let esp32Rssi = 0;
let esp32LastError = '';
const browserSockets = new Set();

let rxBytesTotal = 0;
let txBytesTotal = 0;
let packetsForwarded = 0;
let lastPacketTime = Date.now();

// Fast no-op error callback to avoid allocating closures on every packet
const noop = () => {};

// Active Mission Upload Job Tracking
let currentUploadJob = {
  upload_id: null,
  status: 'IDLE', // IDLE | UPLOADING | SUCCESS | FAILED
  itemCount: 0,
  lastSeqRequested: -1,
  lastAckResult: null,
  startTime: 0,
  durationMs: 0,
  errorMessage: null
};

// State propagation helper adhering to SAE INDIA ADDC 2026 Wire Protocol Contract
function getRelayStatus() {
  const isConnectorOnline = connectorSocket !== null && connectorSocket.readyState === 1;
  return {
    type: 'RELAY_STATUS',
    cloud: 'CONNECTED',
    esp32: esp32Online ? 'ONLINE' : 'OFFLINE',
    esp32Baud: esp32Baud || 57600,
    esp32Rssi: esp32Rssi || 0,
    clients: browserSockets.size,
    timestamp: Date.now(),
    connectorOnline: isConnectorOnline,
    esp32Online: esp32Online
  };
}

function broadcastRelayStatus() {
  const statusMsg = JSON.stringify(getRelayStatus());
  for (const client of browserSockets) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(statusMsg, noop);
      } catch (err) {}
    }
  }
}

// Create HTTP server for health checks, static frontend, and WebSocket upgrades
const server = http.createServer((req, res) => {
  let reqUrl;
  try {
    reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }
  const pathname = reqUrl.pathname;

  // Universal CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-relay-token'
    });
    res.end();
    return;
  }
  
  if (pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store'
    });
    res.end(JSON.stringify({
      service: 'SAE INDIA Ultra-Low-Latency MAVLink WSS Relay',
      status: 'ok',
      uptime: process.uptime(),
      connectorOnline: connectorSocket !== null && connectorSocket.readyState === WebSocket.OPEN,
      esp32Online,
      esp32Baud,
      esp32Rssi,
      esp32LastError,
      browserClientsCount: browserSockets.size,
      rxBytesTotal,
      txBytesTotal,
      packetsForwarded,
      lastPacketAgeMs: Date.now() - lastPacketTime,
      currentUploadJob,
      tcpNoDelay: true,
      perMessageDeflate: false
    }, null, 2));
    return;
  }

  // Mission Upload Job Initiation Endpoint
  if (pathname === '/mission/upload' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const upload_id = payload.upload_id || `up_${Date.now().toString(36).slice(-4)}`;
        const items = payload.items || [];

        if (!items || items.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, error: 'Empty mission items list' }));
          return;
        }

        const isEspOnline = connectorSocket !== null && connectorSocket.readyState === WebSocket.OPEN && esp32Online;
        if (!isEspOnline) {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({
            success: false,
            upload_id,
            error: 'Drone / ESP32 link is offline on cloud relay. Ensure ESP32 is powered and connected to Wi-Fi.'
          }));
          return;
        }

        currentUploadJob = {
          upload_id,
          status: 'UPLOADING',
          itemCount: items.length,
          lastSeqRequested: -1,
          lastAckResult: null,
          startTime: Date.now(),
          durationMs: 0,
          errorMessage: null
        };

        console.log(`[MISSION] upload_id=${upload_id} requested items=${items.length}`);

        // Broadcast mission job start to all connected browsers
        const jobAnnounce = JSON.stringify({
          type: 'MISSION_JOB_START',
          upload_id,
          itemCount: items.length,
          timestamp: Date.now()
        });
        for (const browser of browserSockets) {
          if (browser.readyState === WebSocket.OPEN) {
            try { browser.send(jobAnnounce, noop); } catch (e) {}
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          success: true,
          upload_id,
          message: `Mission upload job registered for ${items.length} items. Streaming over WSS.`,
          status: currentUploadJob
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // Mission Status Query Endpoint
  if (pathname === '/mission/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store'
    });
    res.end(JSON.stringify({
      success: true,
      job: currentUploadJob,
      connectorOnline: connectorSocket !== null && connectorSocket.readyState === WebSocket.OPEN,
      esp32Online,
      esp32Baud,
      esp32Rssi,
      browserClientsCount: browserSockets.size
    }));
    return;
  }

  // If frontend dist is available, serve static files (SPA fallback to index.html)
  if (DIST_PATH) {
    let reqPath = pathname || '/';
    let safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(DIST_PATH, safePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback: return index.html for client-side routing
    const indexPath = path.join(DIST_PATH, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
  }

  if (pathname === '/') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      service: 'SAE INDIA Ultra-Low-Latency MAVLink WSS Relay',
      status: 'ok',
      uptime: process.uptime(),
      connectorOnline: connectorSocket !== null && connectorSocket.readyState === WebSocket.OPEN,
      esp32Online,
      esp32Baud,
      esp32Rssi,
      esp32LastError,
      browserClientsCount: browserSockets.size,
      uploadJob: currentUploadJob
    }, null, 2));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Create WebSocket server attached to HTTP server:
// 1. perMessageDeflate: false -> CRITICAL: Eliminates zlib compression overhead and 15-50ms compression latency
// 2. maxPayload: 64KB -> Sufficient for MAVLink batches without unbounded memory allocation
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 64 * 1024
});

// Upgrade handler with TCP_NODELAY optimization and multi-token validation
server.on('upgrade', (request, socket, head) => {
  // CRITICAL LOW-LATENCY OPTIMIZATION:
  // Disable Nagle's algorithm immediately on raw TCP stream.
  // Prevents OS TCP buffer from delaying small 14-280 byte MAVLink packets for 40-200ms!
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10000);
  socket.setTimeout(0);

  let reqUrl;
  try {
    reqUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  } catch (e) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const pathname = reqUrl.pathname;
  const normalizedPath = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

  // Reject unknown paths with 404
  if (normalizedPath !== '/connector' && normalizedPath !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Multi-token auth: check ?token= query param or x-relay-token header
  const rawToken = reqUrl.searchParams.get('token') || request.headers['x-relay-token'];
  const token = typeof rawToken === 'string' ? rawToken.trim().replace(/^["']|["']$/g, '') : '';

  if (!isValidToken(token)) {
    const masked = token ? `${token.slice(0, 3)}***` : 'none';
    console.warn(`[AUTH FAILED] Unauthorized ${normalizedPath} attempt from ${socket.remoteAddress} (provided: "${masked}")`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Route: /connector (for ESP32 and local connector agent)
  if (normalizedPath === '/connector') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Re-assert TCP_NODELAY on the underlying upgraded socket
      if (ws._socket) {
        ws._socket.setNoDelay(true);
        ws._socket.setKeepAlive(true, 10000);
      }
      handleConnectorConnection(ws);
    });
    return;
  }

  // Route: /ws (for frontend browser client)
  if (normalizedPath === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (ws._socket) {
        ws._socket.setNoDelay(true);
        ws._socket.setKeepAlive(true, 10000);
      }
      handleBrowserConnection(ws);
    });
    return;
  }
});

// Lightweight MAVLink Frame Inspector for Structured Logging
function inspectMavlinkPacket(buf, direction) {
  if (!buf || buf.length < 8) return;
  const magic = buf[0];
  let msgId = -1;
  let sysId = -1;
  let compId = -1;
  let payloadOffset = 0;

  if (magic === 0xFE && buf.length >= 8) {
    // MAVLink 1.0
    sysId = buf[3];
    compId = buf[4];
    msgId = buf[5];
    payloadOffset = 6;
  } else if (magic === 0xFD && buf.length >= 12) {
    // MAVLink 2.0
    sysId = buf[5];
    compId = buf[6];
    msgId = buf[7] | (buf[8] << 8) | (buf[9] << 16);
    payloadOffset = 10;
  } else {
    return;
  }

  // Inspect mission-relevant frames
  if (msgId === 0) {
    // HEARTBEAT
    if (direction === 'RX') {
      const customMode = buf.readUInt32LE ? buf.readUInt32LE(payloadOffset) : 0;
      // throttle logging to 1 every 5 seconds to prevent spamming
      if (Date.now() - lastHeartbeatLogTime > 5000) {
        lastHeartbeatLogTime = Date.now();
        console.log(`[MAVLINK] RX HEARTBEAT sys=${sysId} comp=${compId} mode=${customMode}`);
      }
    }
  } else if (msgId === 44) {
    // MISSION_COUNT
    const count = buf.readUInt16LE ? buf.readUInt16LE(payloadOffset) : 0;
    const targetSys = buf[payloadOffset + 2] || 1;
    const targetComp = buf[payloadOffset + 3] || 1;
    console.log(`[MAVLINK] TX MISSION_COUNT count=${count} target=${targetSys}/${targetComp} type=MISSION`);
    if (currentUploadJob.status === 'UPLOADING') {
      currentUploadJob.itemCount = count;
    }
  } else if (msgId === 40 || msgId === 51) {
    // MISSION_REQUEST (40) or MISSION_REQUEST_INT (51)
    const reqSeq = buf.readUInt16LE ? buf.readUInt16LE(payloadOffset) : 0;
    const name = msgId === 51 ? 'MISSION_REQUEST_INT' : 'MISSION_REQUEST';
    console.log(`[MAVLINK] RX ${name} seq=${reqSeq}`);
    if (currentUploadJob.status === 'UPLOADING') {
      currentUploadJob.lastSeqRequested = reqSeq;
    }
  } else if (msgId === 39 || msgId === 73) {
    // MISSION_ITEM (39) or MISSION_ITEM_INT (73)
    const seq = buf.readUInt16LE ? buf.readUInt16LE(payloadOffset + 28) : 0;
    const cmd = buf.readUInt16LE ? buf.readUInt16LE(payloadOffset + 30) : 0;
    const frame = buf[payloadOffset + 34];
    const name = msgId === 73 ? 'MISSION_ITEM_INT' : 'MISSION_ITEM';
    console.log(`[MAVLINK] TX ${name} seq=${seq} cmd=${cmd} frame=${frame}`);
  } else if (msgId === 47) {
    // MISSION_ACK (47)
    const ackResult = buf[payloadOffset + 2];
    const ackNames = {
      0: 'ACCEPTED(0)',
      1: 'ERROR(1)',
      2: 'UNSUPPORTED_FRAME(2)',
      3: 'UNSUPPORTED(3)',
      4: 'NO_SPACE(4)',
      5: 'INVALID(5)',
      6: 'INVALID_PARAM1(6)',
      7: 'INVALID_PARAM2(7)',
      8: 'INVALID_PARAM3(8)',
      9: 'INVALID_PARAM4(9)',
      10: 'INVALID_PARAM5(10)',
      11: 'INVALID_PARAM6(11)',
      12: 'INVALID_PARAM7(12)',
      13: 'INVALID_SEQUENCE(13)',
      14: 'DENIED(14)',
      15: 'CANCELLED(15)'
    };
    const resStr = ackNames[ackResult] || `CODE_${ackResult}`;
    console.log(`[MAVLINK] RX MISSION_ACK result=${resStr}`);
    if (currentUploadJob.status === 'UPLOADING') {
      currentUploadJob.lastAckResult = ackResult;
      currentUploadJob.durationMs = Date.now() - currentUploadJob.startTime;
      if (ackResult === 0) {
        currentUploadJob.status = 'SUCCESS';
        console.log(`[MISSION] upload_id=${currentUploadJob.upload_id} SUCCESS duration=${(currentUploadJob.durationMs / 1000).toFixed(2)}s`);
      } else {
        currentUploadJob.status = 'FAILED';
        currentUploadJob.errorMessage = `MISSION_ACK rejected: ${resStr}`;
        console.warn(`[MISSION] upload_id=${currentUploadJob.upload_id} FAILED: ${resStr}`);
      }
    }
  }
}

let lastHeartbeatLogTime = 0;

// Handle Local Connector / ESP32 connection
function handleConnectorConnection(ws) {
  console.log('[CONNECTOR] Drone / ESP32 connected successfully.');
  
  if (connectorSocket && connectorSocket !== ws) {
    console.warn('[CONNECTOR] Replacing previous connector instance.');
    try {
      connectorSocket.close(1000, 'Superseded by new connector');
    } catch (e) {}
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  connectorSocket = ws;
  esp32Online = true;
  esp32LastError = '';

  // Notify all browsers that drone is now online
  broadcastRelayStatus();

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      lastPacketTime = Date.now();
      if (!esp32Online) {
        esp32Online = true;
        broadcastRelayStatus();
      }
      
      const len = data.byteLength !== undefined ? data.byteLength : (data.length || 0);
      rxBytesTotal += len;
      packetsForwarded++;

      // Inspect incoming packet for mission events
      inspectMavlinkPacket(data, 'RX');

      // ULTRA-FAST ZERO-COPY FORWARDING:
      // Transmit directly to all open browsers with client backpressure check
      if (browserSockets.size > 0) {
        for (const browser of browserSockets) {
          if (browser.readyState === WebSocket.OPEN) {
            // Drop packet for this specific client if client buffer is congested (>=64KB)
            // to prevent lagging behind realtime telemetry
            if (browser.bufferedAmount < 65536) {
              browser.send(data, { binary: true, mask: false }, noop);
            }
          }
        }
      }
    } else {
      // Text control message: handle QR_ALERT, ESP32_DIAG, and ESP32_STATUS
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      let isBroadcastText = false;
      let broadcastType = '';
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'QR_ALERT' || msg.type === 'ESP32_DIAG') {
          isBroadcastText = true;
          broadcastType = msg.type;
        } else if (msg.type === 'ESP32_STATUS') {
          esp32Online = msg.status === 'CONNECTED' || msg.esp32Online === true;
          if (msg.status === 'DISCONNECTED' || msg.esp32Online === false) {
            esp32Online = false;
          }
          if (msg.baud !== undefined || msg.esp32Baud !== undefined) {
            esp32Baud = Number(msg.esp32Baud !== undefined ? msg.esp32Baud : msg.baud) || 57600;
          }
          if (msg.rssi !== undefined || msg.esp32Rssi !== undefined) {
            esp32Rssi = Number(msg.esp32Rssi !== undefined ? msg.esp32Rssi : msg.rssi) || 0;
          }
          esp32LastError = msg.error || '';
          console.log(`[CONNECTOR REPORT] ESP32 status: ${esp32Online ? 'ONLINE' : 'OFFLINE'} (baud=${esp32Baud}, rssi=${esp32Rssi})`);
          broadcastRelayStatus();
        }
      } catch (err) {
        if (text.includes('QR_ALERT')) {
          isBroadcastText = true;
          broadcastType = 'QR_ALERT';
        } else if (text.includes('ESP32_DIAG')) {
          isBroadcastText = true;
          broadcastType = 'ESP32_DIAG';
        }
      }

      // Forward text frames (QR_ALERT, ESP32_DIAG) from /connector to all connected /ws browser sockets
      if (isBroadcastText) {
        console.log(`[${broadcastType || 'BROADCAST'}] Forwarding to ${browserSockets.size} GCS client(s): ${text.slice(0, 100)}`);
        for (const browser of browserSockets) {
          if (browser.readyState === WebSocket.OPEN && browser.bufferedAmount < 65536) {
            try {
              browser.send(text, noop);
            } catch (e) {}
          }
        }
      }
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`[CONNECTOR] Drone / ESP32 disconnected (${code}: ${reason || 'Closed'}).`);
    if (connectorSocket === ws) {
      connectorSocket = null;
      esp32Online = false;
      esp32LastError = 'ESP32 connector offline';
      broadcastRelayStatus();
    }
  });

  ws.on('error', (err) => {
    console.error('[CONNECTOR ERROR]', err.message);
  });
}

// Handle Browser Frontend connection
function handleBrowserConnection(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  browserSockets.add(ws);
  console.log(`[BROWSER] Frontend client connected (Active clients: ${browserSockets.size})`);

  // Broadcast immediate status update with updated client count to all browsers
  broadcastRelayStatus();

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const len = data.byteLength !== undefined ? data.byteLength : (data.length || 0);
      txBytesTotal += len;
      
      // Inspect outgoing packet from browser for mission events
      inspectMavlinkPacket(data, 'TX');

      // IMMEDIATE ZERO-DELAY COMMAND DISPATCH:
      // Ground Station command (Guided, Takeoff, Arm, RTL, Joystick) forward directly to ESP32 with backpressure check
      if (connectorSocket && connectorSocket.readyState === WebSocket.OPEN) {
        if (connectorSocket.bufferedAmount < 65536) {
          connectorSocket.send(data, { binary: true, mask: false }, noop);
        }
      }
    }
  });

  ws.on('close', () => {
    browserSockets.delete(ws);
    console.log(`[BROWSER] Frontend client disconnected (Remaining: ${browserSockets.size})`);
    broadcastRelayStatus();
  });

  ws.on('error', (err) => {
    browserSockets.delete(ws);
    broadcastRelayStatus();
  });
}

// Resilient Heartbeat & Zombie Socket Pruning (Runs every 25 seconds with 2-strike tolerance)
const heartbeatInterval = setInterval(() => {
  // 1. Drone / Connector Check
  if (connectorSocket) {
    if (connectorSocket.isAlive === false) {
      connectorSocket.missedPings = (connectorSocket.missedPings || 0) + 1;
      if (connectorSocket.missedPings >= 2) {
        console.warn('[HEARTBEAT] Connector unresponsive after 2 checks, terminating dead socket.');
        connectorSocket.terminate();
        connectorSocket = null;
        esp32Online = false;
        broadcastRelayStatus();
      }
    } else {
      connectorSocket.isAlive = false;
      try {
        connectorSocket.ping(noop);
      } catch (e) {}
    }
  }

  // 2. Active Browsers Check
  for (const client of browserSockets) {
    if (client.isAlive === false) {
      client.missedPings = (client.missedPings || 0) + 1;
      if (client.missedPings >= 2) {
        client.terminate();
        browserSockets.delete(client);
      }
    } else {
      client.isAlive = false;
      try {
        client.ping(noop);
      } catch (e) {}
    }
  }
}, 25000);

heartbeatInterval.unref();

// Render anti-sleep self-ping: 4-minute interval HTTP GET to /health
const PING_TARGET_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || 'https://vishal-done-backup.onrender.com';
if (!process.env.DISABLE_KEEP_ALIVE) {
  const keepAliveInterval = setInterval(() => {
    try {
      let target = PING_TARGET_URL.trim();
      if (!/^https?:\/\//i.test(target)) {
        target = 'https://' + target.replace(/^(wss?:\/\/)+/i, '');
      }
      const pingUrl = new URL('/health', target);
      const requester = pingUrl.protocol === 'https:' ? https : http;
      requester.get(pingUrl.href, { timeout: 8000 }, (res) => {
        res.resume(); // drain response body
      }).on('error', () => {
        // Silently ignore ping errors
      });
    } catch (e) {}
  }, 240000); // 4-minute interval (240000 ms)
  keepAliveInterval.unref();
}

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 SAE INDIA ULTRA-LOW-LATENCY WSS RELAY ACTIVE`);
  console.log(`📡 Port:               ${PORT}`);
  console.log(`⚡ TCP_NODELAY:        ENABLED (0ms Nagle buffering delay)`);
  console.log(`🗜️  perMessageDeflate:  DISABLED (0ms zlib latency)`);
  console.log(`🔒 Multi-Token Auth:   ENABLED`);
  console.log(`🌐 Browser Endpoint:   /ws`);
  console.log(`🔌 Drone Endpoint:     /connector`);
  console.log(`❤️  Health Check:       http://localhost:${PORT}/health`);
  console.log(`=======================================================`);
});
