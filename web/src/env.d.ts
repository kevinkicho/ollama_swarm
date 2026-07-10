/// <reference types="vite/client" />

declare const __BACKEND_PORT__: number;

interface ImportMetaEnv {
  readonly VITE_SWARM_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
