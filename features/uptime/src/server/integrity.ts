import { createHash } from 'node:crypto';

import { BUILD_MANIFEST_PATH, buildManifestSchema } from '@deveye/types';

// Le garde des appels sortants, partagé par toute l'app : la sonde suit une
// adresse qu'un membre a saisie, et relit chaque fichier que le site sert.
import { BROWSER_UA, safeFetch } from '@/Services/netFetch';

import type { IntegrityBaseline } from './_shared';

/**
 * Le contrôle d'intégrité : les fichiers qu'un site sert, relus et comparés à
 * une référence. Trois fonctions pures de tout état, la lecture réseau injectée,
 * pour se tester sans serveur.
 *
 * La liste des fichiers vient du site lui-même (son manifeste de build, sinon
 * la page) : un serveur compromis peut la réécrire, mais la comparaison se fait
 * contre la référence retenue ICI, manifeste compris. Un fichier qu'il retire
 * de la liste manque à l'appel, un fichier qu'il modifie change d'empreinte.
 */

/** Ce que rend une lecture de fichier ; `null` : le corps ne se lit pas. */
export type FetchFn = (url: string, timeoutMs: number) => Promise<FetchedFile | null>;

export interface FetchedFile {
    status: number;
    sha256: string;
    /** L'en-tête `content-security-policy`, s'il y en a un. */
    csp: string | null;
    /** Le début du corps en texte, pour y lire les balises d'une page. */
    text: string | null;
}

export interface IntegrityCapture {
    csp: string | null;
    files: Record<string, string>;
    source: 'manifest' | 'page';
    /** Le statut du document lui-même. */
    documentStatus: number;
}

export interface IntegrityDiff {
    changed: string[];
    added: string[];
    removed: string[];
    cspChanged: boolean;
}

/** Au-delà, ce n'est plus une page qu'on vérifie : la liste est refusée. */
export const INTEGRITY_FILES_MAX = 400;
/** Un fichier plus gros ne se lit pas en entier : son empreinte serait celle d'un tronçon. */
export const INTEGRITY_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** Ce qu'on garde du document pour y lire ses balises. */
const DOCUMENT_TEXT_MAX_BYTES = 1024 * 1024;
const CONCURRENCY = 4;

/**
 * Lit un fichier par `safeFetch` : l'empreinte est calculée en flux, sans jamais
 * tenir le corps entier, et un corps trop grand fait échouer la lecture plutôt
 * que d'en hacher un morceau.
 */
export const fetchFile: FetchFn = async (url, timeoutMs) => {
    const response = await safeFetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': BROWSER_UA, accept: '*/*' }
    });
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let kept = 0;
    let size = 0;
    if (response.body) {
        for await (const chunk of response.body) {
            const buf = Buffer.from(chunk);
            size += buf.length;
            if (size > INTEGRITY_FILE_MAX_BYTES) {
                await response.body.cancel().catch(() => undefined);
                throw new Error(`Fichier trop volumineux (plus de ${INTEGRITY_FILE_MAX_BYTES / 1024 / 1024} Mo)`);
            }
            hash.update(buf);
            if (kept < DOCUMENT_TEXT_MAX_BYTES) {
                chunks.push(buf);
                kept += buf.length;
            }
        }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return {
        status: response.status,
        sha256: hash.digest('hex'),
        csp: response.headers.get('content-security-policy'),
        text
    };
};

/** Le chemin d'un fichier tel que la référence le nomme : depuis la racine du site, barre en tête. */
function keyOf(origin: string, url: URL): string | null {
    if (url.origin !== origin) return null;
    return url.pathname + url.search;
}

/**
 * Les fichiers qu'une page charge : ses scripts, ses feuilles de style et ses
 * préchargements, de même origine. Une page servie par une autre origine
 * (un CDN) ne se vérifie pas d'ici : ce serait mesurer un autre serveur.
 */
export function filesOfPage(html: string, pageUrl: string): string[] {
    const origin = new URL(pageUrl).origin;
    const found = new Set<string>();
    const attr = (tag: string, name: string): string | null => {
        const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
        return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
    };
    for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
        const isScript = /^<script/i.test(tag);
        const rel = (attr(tag, 'rel') ?? '').toLowerCase();
        const wanted = isScript || rel === 'stylesheet' || rel === 'modulepreload' || rel === 'preload';
        if (!wanted) continue;
        const ref = attr(tag, isScript ? 'src' : 'href');
        if (!ref || ref.startsWith('data:')) continue;
        let url: URL;
        try {
            url = new URL(ref, pageUrl);
        } catch {
            continue;
        }
        const key = keyOf(origin, url);
        if (key) found.add(key);
    }
    return [...found].sort();
}

/** Ce que l'écran ajoute : des chemins depuis la racine, nettoyés une fois. */
function extraPaths(paths: readonly string[]): string[] {
    return paths.map((p) => p.trim()).filter((p) => p.startsWith('/'));
}

/**
 * Relit le site entier et rend ses empreintes. Le document d'abord (sa
 * politique et, faute de manifeste, sa liste), puis chaque fichier, quatre à la
 * fois. Une seule lecture qui échoue fait échouer la capture : une référence
 * apprise sur un site à moitié lu manquerait des fichiers pour toujours.
 */
export async function captureSite(
    pageUrl: string,
    paths: readonly string[],
    timeoutMs: number,
    fetch: FetchFn = fetchFile
): Promise<IntegrityCapture> {
    const page = new URL(pageUrl);
    const origin = page.origin;
    const documentKey = page.pathname + page.search;

    const document = await fetch(pageUrl, timeoutMs);
    if (!document) throw new Error('Document illisible');
    if (document.status < 200 || document.status >= 400) {
        throw new Error(`Statut HTTP ${document.status} sur le document`);
    }

    let source: IntegrityCapture['source'] = 'page';
    let keys: string[];
    const manifest = await fetch(`${origin}${BUILD_MANIFEST_PATH}`, timeoutMs).catch(() => null);
    const listed = manifest && manifest.status === 200 && manifest.text ? parseManifest(manifest.text) : null;
    if (listed) {
        source = 'manifest';
        // Le manifeste lui-même en fait partie : le réécrire se voit.
        keys = [BUILD_MANIFEST_PATH, ...listed.map((f) => (f === 'index.html' ? '/' : `/${f}`))];
    } else {
        keys = filesOfPage(document.text ?? '', pageUrl);
    }
    const all = new Set([documentKey, ...keys, ...extraPaths(paths)]);
    if (all.size > INTEGRITY_FILES_MAX) {
        throw new Error(`Plus de ${INTEGRITY_FILES_MAX} fichiers à vérifier : le contrôle ne les relira pas tous`);
    }

    const files: Record<string, string> = { [documentKey]: document.sha256 };
    const pending = [...all].filter((k) => k !== documentKey);
    for (let at = 0; at < pending.length; at += CONCURRENCY) {
        await Promise.all(
            pending.slice(at, at + CONCURRENCY).map(async (key) => {
                const file = await fetch(`${origin}${key}`, timeoutMs);
                if (!file) throw new Error(`Fichier illisible : ${key}`);
                // Un refus n'est pas une empreinte : un 429 du limiteur de débit
                // du site passerait sinon pour un fichier modifié.
                if (file.status < 200 || file.status >= 300) {
                    throw new Error(
                        file.status === 429
                            ? `Le site limite les requêtes (429 sur ${key}) : espacez les relèves`
                            : `Statut HTTP ${file.status} sur ${key}`
                    );
                }
                files[key] = file.sha256;
            })
        );
    }
    return { csp: document.csp, files, source, documentStatus: document.status };
}

/** Les chemins d'un manifeste de build valide, `null` pour tout autre contenu. */
function parseManifest(text: string): string[] | null {
    try {
        const parsed = buildManifestSchema.safeParse(JSON.parse(text));
        return parsed.success ? Object.keys(parsed.data.files) : null;
    } catch {
        return null;
    }
}

export function diffCapture(baseline: IntegrityBaseline, capture: IntegrityCapture): IntegrityDiff {
    const before = baseline.files;
    const after = capture.files;
    const changed = Object.keys(before).filter((k) => k in after && after[k] !== before[k]);
    const removed = Object.keys(before).filter((k) => !(k in after));
    const added = Object.keys(after).filter((k) => !(k in before));
    return {
        changed: changed.sort(),
        added: added.sort(),
        removed: removed.sort(),
        cspChanged: (baseline.csp ?? '') !== (capture.csp ?? '')
    };
}

export function hasDrift(diff: IntegrityDiff): boolean {
    return diff.changed.length + diff.added.length + diff.removed.length > 0 || diff.cspChanged;
}

/** Une ligne : ce que porte `last_error` et la carte de la liste. */
export function describeDrift(diff: IntegrityDiff): string {
    const parts: string[] = [];
    const n = (count: number, word: string) => `${count} fichier${count > 1 ? 's' : ''} ${word}${count > 1 ? 's' : ''}`;
    if (diff.changed.length > 0) parts.push(n(diff.changed.length, 'modifié'));
    if (diff.added.length > 0) parts.push(n(diff.added.length, 'ajouté'));
    if (diff.removed.length > 0) parts.push(n(diff.removed.length, 'retiré'));
    if (diff.cspChanged) parts.push('politique de contenu modifiée');
    return `Intégrité : ${parts.join(', ')}`;
}

/** Le détail, fichier par fichier, pour l'incident et l'alerte. Borné : une alerte se lit d'un coup. */
export function detailDrift(diff: IntegrityDiff, max = 20): string[] {
    const lines: string[] = [];
    const list = (label: string, keys: string[]) => {
        for (const key of keys.slice(0, max)) lines.push(`${label} ${key}`);
        if (keys.length > max) lines.push(`… et ${keys.length - max} autre(s) ${label.toLowerCase()}`);
    };
    list('Modifié :', diff.changed);
    list('Ajouté :', diff.added);
    list('Retiré :', diff.removed);
    if (diff.cspChanged) lines.push('Politique de contenu (CSP) modifiée');
    return lines;
}
