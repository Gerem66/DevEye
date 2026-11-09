import path from 'path';

/** Le client, l'app `DevEye/` qui le contient, et la racine du chantier où vivent les checkouts frères. */
export const CLIENT_DIR = path.resolve(__dirname, '..');
export const APP_DIR = path.resolve(CLIENT_DIR, '..');
export const WORKSPACE_DIR = path.resolve(APP_DIR, '..');
