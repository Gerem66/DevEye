/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_SERVER_URL: string
    readonly VITE_VPS_IP: string
    readonly VITE_VPS_PORT: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
