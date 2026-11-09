/**
 * Le dossier où DevEye sert les fichiers de pdf.js (polices standard, tables
 * CMap, décodeurs d'images), posé par `client/vite/plugins/pdfjsAssets.ts` sous un chemin
 * versionné. Le paquet ne connaît aucun CDN : sans ce dossier, un PDF dont les
 * polices ne sont pas embarquées s'afficherait en carrés.
 */
declare const __PDFJS_ASSET_PATH__: string | undefined;

export const PDFJS_ASSETS: string = typeof __PDFJS_ASSET_PATH__ === 'string' ? __PDFJS_ASSET_PATH__ : '/assets/pdfjs/';
