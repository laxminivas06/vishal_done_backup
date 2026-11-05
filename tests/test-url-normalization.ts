import { normalizeSecureRelayUrl, normalizeEsp32WsUrl, parseWsEndpoint } from '../frontend/src/services/transports/Esp32WebSocketTransport';

console.log('===============================================================');
console.log('🧪 URL NORMALIZATION & PROTOCOL INTEGRITY TEST');
console.log('===============================================================\n');

let passed = 0;
let failed = 0;

function assert(description: string, actual: string | object, expected: string | object) {
  const isMatch = typeof expected === 'object'
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;

  if (isMatch) {
    console.log(`  ✓ [PASS] ${description}`);
    passed++;
  } else {
    console.error(`  ✗ [FAIL] ${description}`);
    console.error(`     Expected: ${JSON.stringify(expected)}`);
    console.error(`     Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// 1. normalizeSecureRelayUrl tests
assert(
  'Empty string defaults to canonical WSS relay URL with /ws',
  normalizeSecureRelayUrl(''),
  'wss://vishal-done-backup.onrender.com/ws'
);

assert(
  'Raw domain without protocol or path appends wss:// and /ws',
  normalizeSecureRelayUrl('vishal-done-backup.onrender.com'),
  'wss://vishal-done-backup.onrender.com/ws'
);

assert(
  'HTTPS URL without path converts to wss:// and appends /ws',
  normalizeSecureRelayUrl('https://vishal-done-backup.onrender.com'),
  'wss://vishal-done-backup.onrender.com/ws'
);

assert(
  'HTTPS URL with trailing slash converts to wss:// and appends /ws',
  normalizeSecureRelayUrl('https://vishal-done-backup.onrender.com/'),
  'wss://vishal-done-backup.onrender.com/ws'
);

assert(
  'Nested repeated protocol prefix wss://https:// is cleaned',
  normalizeSecureRelayUrl('wss://https://vishal-done-backup.onrender.com/ws'),
  'wss://vishal-done-backup.onrender.com/ws'
);

assert(
  'Accidental /connector path in GCS browser relay URL is normalized to /ws',
  normalizeSecureRelayUrl('https://vishal-done-backup.onrender.com/connector'),
  'wss://vishal-done-backup.onrender.com/ws'
);

assert(
  'Trailing slash on /connector with query param is normalized to /ws',
  normalizeSecureRelayUrl('https://vishal-done-backup.onrender.com/connector/?token=test123'),
  'wss://vishal-done-backup.onrender.com/ws?token=test123'
);

assert(
  'Trailing slash with query param is normalized to /ws',
  normalizeSecureRelayUrl('https://vishal-done-backup.onrender.com/?token=test123'),
  'wss://vishal-done-backup.onrender.com/ws?token=test123'
);

assert(
  'Empty fallbackPath defaults to /ws',
  normalizeSecureRelayUrl('https://vishal-done-backup.onrender.com', ''),
  'wss://vishal-done-backup.onrender.com/ws'
);

assert(
  'Preserves query parameters on secure URL',
  normalizeSecureRelayUrl('https://vishal-done-backup.onrender.com/ws?token=test123'),
  'wss://vishal-done-backup.onrender.com/ws?token=test123'
);

// 2. normalizeEsp32WsUrl tests
assert(
  'Empty string defaults to canonical local ESP32 ws:// URL',
  normalizeEsp32WsUrl(''),
  'ws://192.168.31.194:8080/ws'
);

assert(
  'Raw IP and port appends ws:// and /ws',
  normalizeEsp32WsUrl('192.168.31.194:8080'),
  'ws://192.168.31.194:8080/ws'
);

assert(
  'HTTP scheme is converted to unencrypted ws://',
  normalizeEsp32WsUrl('http://192.168.31.194:8080/ws'),
  'ws://192.168.31.194:8080/ws'
);

assert(
  'WSS scheme accidentally entered for local ESP32 is converted to ws://',
  normalizeEsp32WsUrl('wss://192.168.31.194:8080/ws'),
  'ws://192.168.31.194:8080/ws'
);

assert(
  'Raw IP without port attaches default port 8080 and /ws',
  normalizeEsp32WsUrl('192.168.31.194'),
  'ws://192.168.31.194:8080/ws'
);

assert(
  'Raw IP with /ws path but without port attaches default port 8080',
  normalizeEsp32WsUrl('192.168.31.194/ws'),
  'ws://192.168.31.194:8080/ws'
);

assert(
  'Raw IP with port and trailing slash appends /ws',
  normalizeEsp32WsUrl('192.168.31.194:8080/'),
  'ws://192.168.31.194:8080/ws'
);

assert(
  'Empty fallbackPath defaults safely to /ws',
  normalizeEsp32WsUrl('192.168.31.194:8080', ''),
  'ws://192.168.31.194:8080/ws'
);

assert(
  'Custom port and path are preserved',
  normalizeEsp32WsUrl('ws://192.168.1.50:9000/telemetry'),
  'ws://192.168.1.50:9000/telemetry'
);

// 3. parseWsEndpoint tests
assert(
  'parseWsEndpoint parses standard ws:// URL',
  parseWsEndpoint('ws://192.168.31.194:8080/ws'),
  { host: '192.168.31.194', port: 8080, path: '/ws' }
);

assert(
  'parseWsEndpoint handles schemeless custom IP, port, and path',
  parseWsEndpoint('10.0.0.5:9090/telemetry'),
  { host: '10.0.0.5', port: 9090, path: '/telemetry' }
);

assert(
  'parseWsEndpoint parses secure WSS endpoint',
  parseWsEndpoint('wss://vishal-done-backup.onrender.com/ws'),
  { host: 'vishal-done-backup.onrender.com', port: 443, path: '/ws' }
);

assert(
  'parseWsEndpoint handles HTTPS URL without path and defaults to /ws',
  parseWsEndpoint('https://vishal-done-backup.onrender.com'),
  { host: 'vishal-done-backup.onrender.com', port: 443, path: '/ws' }
);

assert(
  'parseWsEndpoint handles empty string input',
  parseWsEndpoint(''),
  { host: '192.168.31.194', port: 8080, path: '/ws' }
);

assert(
  'parseWsEndpoint handles raw IP without port or path',
  parseWsEndpoint('192.168.31.194'),
  { host: '192.168.31.194', port: 8080, path: '/ws' }
);

console.log('\n===============================================================');
console.log(`📊 RESULTS: ${passed}/${passed + failed} PASSED (${failed} FAILED)`);
console.log('===============================================================');

if (failed > 0) process.exit(1);
