const fs = require('fs');
const path = require('path');

const cardPath = path.join(__dirname, '../frontend/src/components/Drone/PixhawkConnectionCard.tsx');
let cContent = fs.readFileSync(cardPath, 'utf8');

const bad1 = "  const cleanPath = esp32Path ? (esp32Path.startsWith('/') ? esp32Path : `/${esp32Path}`) : '';\n  const effectiveProto = esp32Mode === 'SECURE' ? 'wss' : 'ws';\n";
const bad1Crlf = "  const cleanPath = esp32Path ? (esp32Path.startsWith('/') ? esp32Path : `/${esp32Path}`) : '';\r\n  const effectiveProto = esp32Mode === 'SECURE' ? 'wss' : 'ws';\r\n";

cContent = cContent.replace(bad1, '');
cContent = cContent.replace(bad1Crlf, '');

fs.writeFileSync(cardPath, cContent, 'utf8');
console.log('Cleaned up PixhawkConnectionCard.tsx duplicate lines.');
