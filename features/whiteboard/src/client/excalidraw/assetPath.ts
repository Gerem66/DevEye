/**
 * Les polices d'Excalidraw servies par DevEye (le dossier que le build copie,
 * `client/vite.config.ts`) : sans ce chemin, le paquet irait les chercher sur un
 * CDN. Posé depuis le chunk du module, chargé au démarrage : le cœur
 * d'Excalidraw, évalué avant le composant qui l'importe, crée ses polices dès
 * son chargement.
 */
declare const __EXCALIDRAW_ASSET_PATH__: string | undefined;

declare global {
    interface Window {
        EXCALIDRAW_ASSET_PATH?: string | string[];
    }
}

window.EXCALIDRAW_ASSET_PATH =
    typeof __EXCALIDRAW_ASSET_PATH__ === 'string' ? __EXCALIDRAW_ASSET_PATH__ : '/assets/excalidraw/';

export {};
