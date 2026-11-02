import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('=======================================================');
console.log('🚀 SAE INDIA MISSION SYSTEM BUILD PIPELINE');
console.log('=======================================================');

const isRender = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
const isNetlify = Boolean(process.env.NETLIFY);

if (isRender && process.env.BACKEND_ONLY === 'true') {
  console.log('[BUILD] Render backend-only flag set. Skipping frontend build.');
  process.exit(0);
}

try {
  console.log('[BUILD] Compiling frontend (tsc + vite build)...');
  execSync('npm run build --workspace=frontend', {
    cwd: rootDir,
    stdio: 'inherit'
  });
  console.log('[BUILD] Build completed successfully.');
} catch (error) {
  if (isRender) {
    console.warn('[BUILD] Frontend build bypassed on Render backend container.');
    console.warn('[BUILD] Backend relay service will continue to launch.');
    process.exit(0);
  } else {
    console.error('[BUILD] Build failed.');
    process.exit(1);
  }
}
