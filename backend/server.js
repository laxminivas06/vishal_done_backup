import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';

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
const RELAY_TOKEN = process.env.RELAY_TOKEN || 'saeindia_secret_token_2026';

// Global relay state
let connectorSocket = null;
let esp32Online = false;
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

// Create HTTP server for health checks, static frontend, and WebSocket upgrades
const server = http.createServer((req, res) => {
  const parsedUrl = parse(req.url, true);

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
  
  if (parsedUrl.pathname === '/health') {
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
  if (parsedUrl.pathname === '/mission/upload' && req.method === 'POST') {
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
  if (parsedUrl.pathname === '/mission/status') {
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
      browserClientsCount: browserSockets.size
    }));
    return;
  }

  // If frontend dist is available, serve static files (SPA fallback to index.html)
  if (DIST_PATH) {
    let reqPath = parsedUrl.pathname || '/';
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

  if (parsedUrl.pathname === '/') {
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

function broadcastStatusToBrowsers() {
  const statusMsg = JSON.stringify({
    type: 'RELAY_STATUS',
    connectorOnline: connectorSocket !== null && connectorSocket.readyState === WebSocket.OPEN,
    esp32Online: connectorSocket !== null && connectorSocket.readyState === WebSocket.OPEN && esp32Online,
    error: connectorSocket === null 
      ? 'ESP32 connector offline' 
      : (!esp32Online ? (esp32LastError || 'ESP32 unavailable') : null)
  });

  for (const client of browserSockets) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(statusMsg, noop);
      } catch (err) {}
    }
  }
}

// Upgrade handler with TCP_NODELAY optimization and token validation
server.on('upgrade', (request, socket, head) => {
  // CRITICAL LOW-LATENCY OPTIMIZATION:
  // Disable Nagle's algorithm immediately on raw TCP stream.
  // Prevents OS TCP buffer from delaying small 14-280 byte MAVLink packets for 40-200ms!
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10000);
  socket.setTimeout(0);

  const parsedUrl = parse(request.url, true);
  const pathname = parsedUrl.pathname;
  const token = parsedUrl.query.token || request.headers['x-relay-token'];

  const allowedTokens = new Set([
    RELAY_TOKEN ? RELAY_TOKEN.trim() : '',
    'saeindia_secret_token_2026',
    'saeindia_sec_99348a7b1c0e'
  ].filter(Boolean));

  const validateAuth = (routeLabel) => {
    if (allowedTokens.size > 0) {
      if (!token || !allowedTokens.has(token.trim())) {
        const masked = token ? `${token.trim().slice(0, 3)}***` : 'none';
        console.warn(`[AUTH FAILED] Unauthorized ${routeLabel} attempt from ${request.socket.remoteAddress} (provided: "${masked}")`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return false;
      }
    }
    return true;
  };

  // Route: /connector (for ESP32 and local connector agent)
  if (pathname === '/connector') {
    if (!validateAuth('ESP32/connector')) return;

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

  // Route: /ws or / (for frontend browser client)
  if (pathname === '/ws' || pathname === '/') {
    if (!validateAuth('browser client')) return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      if (ws._socket) {
        ws._socket.setNoDelay(true);
        ws._socket.setKeepAlive(true, 10000);
      }
      handleBrowserConnection(ws);
    });
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

// Lightweight MAVLink Frame Inspector for Structured Logging (Section 3 requirement)
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
  broadcastStatusToBrowsers();

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      lastPacketTime = Date.now();
      if (!esp32Online) {
        esp32Online = true;
        broadcastStatusToBrowsers();
      }
      
      rxBytesTotal += data.length;
      packetsForwarded++;

      // Inspect incoming packet for mission events
      inspectMavlinkPacket(data, 'RX');

      // ULTRA-FAST ZERO-COPY FORWARDING:
      // Transmit directly to all open browsers with no queuing and no compression delay
      if (browserSockets.size > 0) {
        for (const browser of browserSockets) {
          if (browser.readyState === WebSocket.OPEN) {
            // Drop packet for this specific client if client buffer is congested (>64KB)
            // to prevent lagging behind realtime telemetry
            if (browser.bufferedAmount < 65536) {
              browser.send(data, { binary: true, mask: false }, noop);
            }
          }
        }
      }
    } else {
      // JSON control message
      try {
        const text = data.toString();
        const msg = JSON.parse(text);
        if (msg.type === 'ESP32_STATUS') {
          esp32Online = msg.status === 'CONNECTED';
          esp32LastError = msg.error || '';
          console.log(`[CONNECTOR REPORT] ESP32 status: ${msg.status} ${esp32LastError ? `(${esp32LastError})` : ''}`);
          broadcastStatusToBrowsers();
        }
      } catch (err) {
        // Non-JSON control packet ignored
      }
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`[CONNECTOR] Drone / ESP32 disconnected (${code}: ${reason || 'Closed'}).`);
    if (connectorSocket === ws) {
      connectorSocket = null;
      esp32Online = false;
      esp32LastError = 'ESP32 connector offline';
      broadcastStatusToBrowsers();
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

  // Send immediate initial status
  const initialStatus = JSON.stringify({
    type: 'RELAY_STATUS',
    connectorOnline: connectorSocket !== null && connectorSocket.readyState === WebSocket.OPEN,
    esp32Online: connectorSocket !== null && connectorSocket.readyState === WebSocket.OPEN && esp32Online,
    error: connectorSocket === null 
      ? 'ESP32 connector offline' 
      : (!esp32Online ? (esp32LastError || 'ESP32 unavailable') : null)
  });
  try {
    ws.send(initialStatus, noop);
  } catch (e) {}

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      txBytesTotal += data.length;
      
      // Inspect outgoing packet from browser for mission events
      inspectMavlinkPacket(data, 'TX');

      // IMMEDIATE ZERO-DELAY COMMAND DISPATCH:
      // Ground Station command (Guided, Takeoff, Arm, RTL, Joystick) forward directly to ESP32
      if (connectorSocket && connectorSocket.readyState === WebSocket.OPEN) {
        connectorSocket.send(data, { binary: true, mask: false }, noop);
      }
    }
  });

  ws.on('close', () => {
    browserSockets.delete(ws);
    console.log(`[BROWSER] Frontend client disconnected (Remaining: ${browserSockets.size})`);
  });

  ws.on('error', (err) => {
    browserSockets.delete(ws);
  });
}

// Low-latency Heartbeat & Zombie Socket Pruning (Runs every 10 seconds)
const heartbeatInterval = setInterval(() => {
  // 1. Drone / Connector Check
  if (connectorSocket) {
    if (connectorSocket.isAlive === false) {
      console.warn('[HEARTBEAT] Connector unresponsive, terminating dead socket.');
      connectorSocket.terminate();
      connectorSocket = null;
      esp32Online = false;
      broadcastStatusToBrowsers();
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
      client.terminate();
      browserSockets.delete(client);
    } else {
      client.isAlive = false;
      try {
        client.ping(noop);
      } catch (e) {}
    }
  }
}, 10000);

heartbeatInterval.unref();

// Anti-Sleep Self-Ping (Keeps Render free-tier container active and prevents cold-start spin-down delays)
const PING_TARGET_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || 'https://vishal-done-backup.onrender.com';
if (PING_TARGET_URL && !process.env.DISABLE_KEEP_ALIVE) {
  const keepAliveInterval = setInterval(() => {
    try {
      const pingUrl = new URL('/health', PING_TARGET_URL);
      const requester = pingUrl.protocol === 'https:' ? https : http;
      requester.get(pingUrl.href, { timeout: 8000 }, (res) => {
        res.resume(); // drain response body
      }).on('error', () => {
        // Silently ignore ping errors
      });
    } catch (e) {}
  }, 240000); // Every 4 minutes (Render sleep threshold is 15 minutes)
  keepAliveInterval.unref();
}

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 SAE INDIA ULTRA-LOW-LATENCY WSS RELAY ACTIVE`);
  console.log(`📡 Port:               ${PORT}`);
  console.log(`⚡ TCP_NODELAY:        ENABLED (0ms Nagle buffering delay)`);
  console.log(`🗜️  perMessageDeflate:  DISABLED (0ms zlib latency)`);
  console.log(`🔒 Token Auth:         ${RELAY_TOKEN ? 'ENABLED' : 'DEFAULT'}`);
  console.log(`🌐 Browser Endpoint:   /ws`);
  console.log(`🔌 Drone Endpoint:     /connector`);
  console.log(`❤️  Health Check:       http://localhost:${PORT}/health`);
  console.log(`=======================================================`);
});
