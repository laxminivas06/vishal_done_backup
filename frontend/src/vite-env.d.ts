/// <reference types="vite/client" />
/// <reference types="react" />
/// <reference types="react-dom" />

interface ImportMetaEnv {
  readonly VITE_ESP32_WS_URL?: string;
  readonly VITE_SECURE_RELAY_URL?: string;
  readonly VITE_RELAY_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
