const fs = require('fs');
const path = require('path');

// 1. PATCH Esp32WebSocketTransport.ts
const transportPath = path.join(__dirname, '../frontend/src/services/transports/Esp32WebSocketTransport.ts');
let tContent = fs.readFileSync(transportPath, 'utf8');

const normFunction = [
  '/**',
  ' * Normalizes any user or environment relay URL into a canonical, valid WSS URL.',
  ' * Strips repeated/nested protocols (e.g. "wss://https://...", "https://...", "ws://...")',
  ' * and ensures canonical route path (defaults to \'/ws\') and query strings are preserved.',
  ' */',
  'export function normalizeSecureRelayUrl(input: string, fallbackPath = \'/ws\'): string {',
  '  let cleaned = (input || \'\').trim();',
  '  if (!cleaned) return \'wss://vishal-done-backup.onrender.com/ws\';',
  '',
  '  // Strip any nested or repeated protocol prefixes: wss://, ws://, https://, http://',
  '  cleaned = cleaned.replace(/^(wss?:\\/\\/|https?:\\/\\/)+/i, \'\');',
  '',
  '  // Separate query parameters if any',
  '  const qIdx = cleaned.indexOf(\'?\');',
  '  let hostAndPath = qIdx >= 0 ? cleaned.slice(0, qIdx) : cleaned;',
  '  const queryString = qIdx >= 0 ? cleaned.slice(qIdx) : \'\';',
  '',
  '  // Strip trailing slashes',
  '  hostAndPath = hostAndPath.replace(/\\/+$/, \'\');',
  '',
  '  // If there\'s no path (e.g. "vishal-done-backup.onrender.com"), append fallbackPath',
  '  if (!hostAndPath.includes(\'/\')) {',
  '    const formatted = fallbackPath.startsWith(\'/\') ? fallbackPath : \'/\' + fallbackPath;',
  '    hostAndPath = hostAndPath + formatted;',
  '  }',
  '',
  '  return \'wss://\' + hostAndPath + queryString;',
  '}',
  '',
  'function parseWsEndpoint('
].join('\n');

if (!tContent.includes('export function normalizeSecureRelayUrl')) {
  tContent = tContent.replace('function parseWsEndpoint(', normFunction);
}

// In constructor
tContent = tContent.replace(
  'this.secureEndpoint = savedSecureEndpoint.trim();',
  'this.secureEndpoint = normalizeSecureRelayUrl(savedSecureEndpoint);'
);
tContent = tContent.replace(
  'this.secureEndpoint = ENV_SECURE_RELAY_URL;',
  'this.secureEndpoint = normalizeSecureRelayUrl(ENV_SECURE_RELAY_URL);'
);

// In getResolvedUrl: replace the wss branch
const oldResolvedWssRegex = /if \(proto === 'wss'\) \{[\s\S]*?return url;\s*\}/;
const newResolvedWss = [
  "if (proto === 'wss') {",
  "      let ep = (this.secureEndpoint || ENV_SECURE_RELAY_URL || 'wss://vishal-done-backup.onrender.com/ws').trim();",
  "      let url = normalizeSecureRelayUrl(ep, formattedPath || '/ws');",
  "",
  "      // Append token if configured and not already included",
  "      const tokenToUse = (this.relayToken || ENV_RELAY_TOKEN).trim();",
  "      if (tokenToUse && !url.includes('token=')) {",
  "        const sep = url.includes('?') ? '&' : '?';",
  "        url = `${url}${sep}token=${encodeURIComponent(tokenToUse)}`;",
  "      }",
  "",
  "      return url;",
  "    }"
].join('\n');

tContent = tContent.replace(oldResolvedWssRegex, newResolvedWss);

// In setConfig
tContent = tContent.replace(
  'this.secureEndpoint = options.secureEndpoint.trim();',
  "this.secureEndpoint = normalizeSecureRelayUrl(options.secureEndpoint.trim(), this.path || '/ws');"
);

fs.writeFileSync(transportPath, tContent, 'utf8');
console.log('✓ Esp32WebSocketTransport.ts patched.');

// 2. PATCH PixhawkConnectionCard.tsx
const cardPath = path.join(__dirname, '../frontend/src/components/Drone/PixhawkConnectionCard.tsx');
let cContent = fs.readFileSync(cardPath, 'utf8');

// Add import
if (!cContent.includes('normalizeSecureRelayUrl')) {
  cContent = cContent.replace(
    "import { SerialDiagnosticsModal } from './SerialDiagnosticsModal';",
    "import { SerialDiagnosticsModal } from './SerialDiagnosticsModal';\nimport { normalizeSecureRelayUrl } from '../../services/transports/Esp32WebSocketTransport';"
  );
}

// Initial state for esp32SecureEndpoint
const oldStateRegex = /const \[esp32SecureEndpoint, setEsp32SecureEndpoint\] = useState<string>\(\(\) => \{[\s\S]*?return \(typeof import\.meta !== 'undefined' && import\.meta\.env\?\.VITE_SECURE_RELAY_URL\) \|\| 'wss:\/\/vishal-done-backup\.onrender\.com\/ws';\s*\}\);/;
const newState = [
  "const [esp32SecureEndpoint, setEsp32SecureEndpoint] = useState<string>(() => {",
  "    if (typeof window !== 'undefined') {",
  "      const saved = localStorage.getItem('esp32_secure_endpoint');",
  "      if (saved && saved.trim().length > 0 && !saved.includes('192.168.')) {",
  "        return normalizeSecureRelayUrl(saved);",
  "      }",
  "    }",
  "    const envUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SECURE_RELAY_URL) || 'wss://vishal-done-backup.onrender.com/ws';",
  "    return normalizeSecureRelayUrl(envUrl);",
  "  });"
].join('\n');
cContent = cContent.replace(oldStateRegex, newState);

// targetHost and resolvedTargetUrl
const oldTargetRegex = /const targetHost = \(esp32Mode === 'SECURE' && esp32SecureEndpoint\)[\s\S]*?const resolvedTargetUrl = \(esp32Mode === 'SECURE' && targetHost\.includes\('\/'\)\)[\s\S]*?: `\$\{effectiveProto\}:\/\/\$\{targetHost\}\$\{cleanPath\}`;/;
const newTarget = [
  "const cleanPath = esp32Path ? (esp32Path.startsWith('/') ? esp32Path : `/${esp32Path}`) : '/ws';",
  "  const effectiveProto = esp32Mode === 'SECURE' ? 'wss' : 'ws';",
  "  const normalizedSecureEp = normalizeSecureRelayUrl(esp32SecureEndpoint, cleanPath);",
  "  const targetHost = (esp32Mode === 'SECURE') ",
  "    ? normalizedSecureEp.replace(/^(wss?:\\/\\/|https?:\\/\\/)+/i, '').replace(/\\/+$/, '') ",
  "    : `${esp32Host}:${esp32Port}`;",
  "  const resolvedTargetUrl = (esp32Mode === 'SECURE')",
  "    ? normalizedSecureEp",
  "    : `${effectiveProto}://${targetHost}${cleanPath}`;"
].join('\n');
cContent = cContent.replace(oldTargetRegex, newTarget);

// handleConnectEsp32: save clean URL to localStorage
cContent = cContent.replace(
  "localStorage.setItem('esp32_secure_endpoint', esp32SecureEndpoint.trim());",
  "const cleanSecureEndpoint = normalizeSecureRelayUrl(esp32SecureEndpoint, esp32Path || '/ws');\n        setEsp32SecureEndpoint(cleanSecureEndpoint);\n        localStorage.setItem('esp32_secure_endpoint', cleanSecureEndpoint);"
);
cContent = cContent.replace(
  "secureEndpoint: esp32SecureEndpoint.trim(),",
  "secureEndpoint: normalizeSecureRelayUrl(esp32SecureEndpoint, esp32Path || '/ws'),"
);

// OnBlur for Cloud WSS Relay input
cContent = cContent.replace(
  'onChange={(e) => setEsp32SecureEndpoint(e.target.value)}',
  'onChange={(e) => setEsp32SecureEndpoint(e.target.value)}\n                  onBlur={(e) => setEsp32SecureEndpoint(normalizeSecureRelayUrl(e.target.value))}'
);

fs.writeFileSync(cardPath, cContent, 'utf8');
console.log('✓ PixhawkConnectionCard.tsx patched.');

// 3. PATCH mavlinkService.ts
const mavlinkPath = path.join(__dirname, '../frontend/src/services/mavlinkService.ts');
let mContent = fs.readFileSync(mavlinkPath, 'utf8');

if (!mContent.includes('normalizeSecureRelayUrl')) {
  mContent = mContent.replace(
    "import { transportManager } from './transports/TransportManager';",
    "import { transportManager } from './transports/TransportManager';\nimport { normalizeSecureRelayUrl } from './transports/Esp32WebSocketTransport';"
  );
}

mContent = mContent.replace(
  "const secureEp = (options?.secureEndpoint || defaultRelayUrl || transportManager.getEsp32Transport().getSecureEndpoint()).trim();",
  "const secureEp = normalizeSecureRelayUrl((options?.secureEndpoint || defaultRelayUrl || transportManager.getEsp32Transport().getSecureEndpoint()).trim(), path || '/ws');"
);

fs.writeFileSync(mavlinkPath, mContent, 'utf8');
console.log('✓ mavlinkService.ts patched.');
