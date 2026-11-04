import http from 'http';
import WebSocket from 'ws';
import { fork } from 'child_process';
import path from 'path';

const PORT = 3099;
const SERVER_PATH = path.resolve(process.cwd(), 'backend/server.js');

async function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runBackendSmokeTest() {
  console.log('\n===============================================================');
  console.log('🛸 SAE INDIA — BACKEND RELAY SMOKE & AUTH HARDENING TEST');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, name: string) {
    if (cond) {
      passed++;
      console.log(`  ✓ [PASS] ${name}`);
    } else {
      failed++;
      console.error(`  ✗ [FAIL] ${name}`);
    }
  }

  // 1. Spawn backend server with custom port
  const child = fork(SERVER_PATH, [], {
    env: { ...process.env, PORT: String(PORT), RELAY_TOKEN: 'saeindia_sec_99348a7b1c0e' },
    stdio: 'pipe'
  });

  try {
    // Wait for server to start listening
    await wait(1200);

    // 2. Test HTTP /health endpoint
    const healthRes = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      });
      req.on('error', reject);
    });

    // 1. /health 200 OK
    assert(healthRes.status === 200, '/health 200 OK');

    // 2. /connector 401 without token
    const connectorNoToken = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/connector`);
      ws.on('open', () => { ws.close(); resolve(false); });
      ws.on('unexpected-response', (req, res) => {
        resolve(res.statusCode === 401);
      });
      ws.on('error', () => { resolve(true); });
    });
    assert(connectorNoToken, '/connector 401 without token');

    // 3. /ws 401 with bad token
    const wsBadToken = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=invalid_unauthorized_token_xyz`);
      ws.on('open', () => { ws.close(); resolve(false); });
      ws.on('unexpected-response', (req, res) => {
        resolve(res.statusCode === 401);
      });
      ws.on('error', () => { resolve(true); });
    });
    assert(wsBadToken, '/ws 401 with bad token');

    // 4. valid primary token handshake
    const wsPrimaryToken = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=saeindia_sec_99348a7b1c0e`);
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => { resolve(false); });
    });
    assert(wsPrimaryToken, 'valid primary token handshake');

    // 5. valid legacy token handshake
    const wsLegacyToken = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=saeindia_secret_token_2026`);
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => { resolve(false); });
    });
    assert(wsLegacyToken, 'valid legacy token handshake');

    // 6. status payload validation
    const statusPayloadValid = Boolean(
      healthRes.body &&
      healthRes.body.status === 'ok' &&
      typeof healthRes.body.uptime === 'number' &&
      typeof healthRes.body.service === 'string'
    );
    assert(statusPayloadValid, 'status payload validation');

  } finally {
    child.kill('SIGTERM');
  }

  console.log('\n===============================================================');
  console.log(`📊 BACKEND SMOKE RESULTS: ${passed}/${passed + failed} PASSED (${failed} FAILED)`);
  console.log('===============================================================\n');

  if (failed > 0) process.exit(1);
}

runBackendSmokeTest().catch(err => {
  console.error('Smoke test failure:', err);
  process.exit(1);
});
