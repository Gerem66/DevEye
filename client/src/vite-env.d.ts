/// <reference types="vite/client" />

// Injected by Vite (`define`) from the root package.json version.
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
    readonly VITE_ENV: 'dev' | 'prod';
    readonly VITE_VPS_IP: string;
    readonly VITE_VPS_PORT: number;
    readonly VITE_SERVER_URL: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
