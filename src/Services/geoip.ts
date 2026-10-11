import { gunzipSync } from 'node:zlib';
import { isPublicIp } from '@deveye/types/sdk/server';
import { Reader, type CountryResponse } from 'mmdb-lib';
import type { Logger } from 'pino';

/**
 * Le pays d'une adresse IP, pour les modules qui déclarent `'geoip'` : la base
 * gratuite de DB-IP (IP to Country Lite, CC BY 4.0), téléchargée au démarrage
 * puis chaque mois, tenue en mémoire. Rien ne part vers un tiers à la lecture :
 * l'adresse reste ici, seul le code du pays en sort.
 */

/** La mention que la licence de la base exige partout où un pays s'affiche. */
export const GEOIP_ATTRIBUTION = { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' } as const;

const SOURCE = 'https://download.db-ip.com/free';
/** Une relecture par jour : la base du mois paraît dans ses premiers jours, on la prend dès qu'elle est là. */
const CHECK_MS = 24 * 3600_000;
/** Après un échec, on retente dans l'heure plutôt que le lendemain. */
const RETRY_MS = 3600_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** La base décompressée pèse quelques dizaines de mégaoctets : au-delà, ce n'est pas elle. */
const MAX_BYTES = 200 * 1024 * 1024;

/** L'édition `AAAA-MM` parue `monthsBack` mois avant `at`. */
export function editionOf(at: Date, monthsBack: number): string {
    const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - monthsBack, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface GeoIpState {
    enabled: boolean;
    edition: string | null;
    loadedAt: number | null;
    error: string | null;
}

interface GeoIpSeam {
    download?(url: string): Promise<Buffer>;
    clock?(): Date;
}

async function download(url: string): Promise<Buffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`DB-IP répond ${res.status} pour ${url}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('Fichier de DB-IP trop volumineux');
    return Buffer.from(await res.arrayBuffer());
}

export function createGeoIp(seam: GeoIpSeam = {}) {
    const fetchFile = seam.download ?? download;
    const clock = seam.clock ?? (() => new Date());
    let logger: Logger | null = null;
    let enabled = false;
    let reader: Reader<CountryResponse> | null = null;
    let edition: string | null = null;
    let loadedAt: number | null = null;
    let error: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = true;

    /** L'édition du mois, sinon celle du mois d'avant ; vrai quand la plus récente disponible est en mémoire. */
    async function refresh(): Promise<boolean> {
        const now = clock();
        let failure: unknown = null;
        for (const back of [0, 1]) {
            const wanted = editionOf(now, back);
            if (wanted === edition) return true;
            try {
                const bytes = gunzipSync(await fetchFile(`${SOURCE}/dbip-country-lite-${wanted}.mmdb.gz`), {
                    maxOutputLength: MAX_BYTES
                });
                reader = new Reader<CountryResponse>(bytes);
                edition = wanted;
                loadedAt = Date.now();
                error = null;
                logger?.info({ edition }, 'base des pays chargée');
                return true;
            } catch (e) {
                failure = e;
            }
        }
        error = failure instanceof Error ? failure.message : String(failure);
        logger?.warn({ err: failure }, 'base des pays indisponible : les pays des visiteurs restent inconnus');
        return false;
    }

    async function cycle(): Promise<void> {
        const ok = await refresh();
        if (stopped) return;
        timer = setTimeout(() => void cycle(), ok ? CHECK_MS : RETRY_MS);
        timer.unref();
    }

    return {
        /** Sans module qui déclare `'geoip'`, rien ne se télécharge. */
        init(opts: { logger: Logger; enabled: boolean }): void {
            logger = opts.logger;
            enabled = opts.enabled;
        },
        start(): void {
            if (!enabled || !stopped) return;
            stopped = false;
            // Sans attendre : le démarrage ne dépend pas d'un serveur tiers.
            void cycle();
        },
        stop(): void {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
        /** `null` pour une adresse privée ou inconnue, et tant que la base n'est pas chargée. */
        country(ip: string): string | null {
            if (!reader) return null;
            const address = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
            if (!isPublicIp(address)) return null;
            try {
                const code = reader.get(address)?.country?.iso_code;
                return code ? code.toUpperCase() : null;
            } catch {
                return null;
            }
        },
        state(): GeoIpState {
            return { enabled, edition, loadedAt, error };
        },
        /** Pour les tests : une relecture tout de suite, sans calendrier. */
        refresh
    };
}

export type GeoIp = ReturnType<typeof createGeoIp>;

export const geoip = createGeoIp();
