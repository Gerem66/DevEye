import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Les scripts d'installation de l'agent (`/install.sh`, `/install.ps1`) : la
 * même source pour toute machine, où seule l'origine du serveur est posée, une
 * fois, au démarrage. Aucun secret n'y entre : le code de liaison arrive par la
 * ligne de commande de celui qui lance le script.
 */

export type InstallerKind = 'sh' | 'ps1';

const PLACEHOLDER = '__DEVEYE_SERVER__';

/**
 * Une origine qu'un script peut porter entre apostrophes sans rien casser :
 * schéma, hôte (nom, IPv4 ou IPv6 entre crochets), port et chemin facultatifs,
 * rien d'autre. Ce qui ne passe pas n'est jamais servi.
 */
const SAFE_ORIGIN = /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;

export function isSafeOrigin(origin: string): boolean {
    return SAFE_ORIGIN.test(origin);
}

/** Le script prêt à servir, ou `null` pour une origine qu'il ne saurait porter. */
export function renderInstaller(template: string, origin: string): string | null {
    const server = origin.replace(/\/+$/, '');
    if (!isSafeOrigin(server)) return null;
    return template.split(PLACEHOLDER).join(server);
}

/** Le gabarit, lu à côté des sources de l'agent. */
export function readInstaller(kind: InstallerKind): string {
    return readFileSync(resolve(process.cwd(), 'agent', 'install', `install.${kind}`), 'utf8');
}
