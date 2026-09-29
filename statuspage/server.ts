import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { STATUS_SCRIPT, STATUS_SCRIPT_ETAG } from '../features/uptime/src/server/statusPage/script';
import { ICON_PATH, SCRIPT_PATH, renderMissing, renderStatus, type RenderOptions } from './render';
import type { StatusView } from './view';

/**
 * Le serveur de la page : quelques chemins en lecture seule, sans dépendance.
 * Le HTML se recalcule au plus toutes les 15 s par chemin : une page partagée
 * pendant une panne se charge beaucoup, les mesures ne changent qu'à la minute.
 */

export const PAGE_CACHE_MS = 15_000;
/** Plus vieux que ça, le dernier passage dit que les mesures sont à l'arrêt. */
export const HEALTHY_TICK_SECONDS = 180;

const FEATURE_PATH = /^\/([a-z0-9][a-z0-9-]{0,63})$/;

const SECURITY_HEADERS = {
    'content-security-policy':
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
};

export interface ServerDeps {
    view(featureId: string | null): StatusView | null;
    render: RenderOptions;
    icon: Buffer;
    lastTick(): number;
    now?: () => number;
}

export function createStatusServer(deps: ServerDeps): Server {
    const now = deps.now ?? Date.now;
    const pages = new Map<string, { status: number; html: string; until: number }>();

    const page = (path: string, featureId: string | null): { status: number; html: string } => {
        const held = pages.get(path);
        if (held && held.until > now()) return held;
        const view = deps.view(featureId);
        const fresh = view
            ? { status: 200, html: renderStatus(view, deps.render) }
            : { status: 404, html: renderMissing(deps.render) };
        // Seuls les chemins connus restent en mémoire : un robot qui essaie mille noms n'y laisse rien.
        if (fresh.status === 200) pages.set(path, { ...fresh, until: now() + PAGE_CACHE_MS });
        return fresh;
    };

    const send = (
        req: IncomingMessage,
        res: ServerResponse,
        status: number,
        type: string,
        body: string | Buffer,
        extra: Record<string, string> = {}
    ): void => {
        res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
        res.end(req.method === 'HEAD' ? undefined : body);
    };

    return createServer((req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(req, res, 405, 'text/plain; charset=utf-8', 'Méthode non permise', { allow: 'GET, HEAD' });
            return;
        }
        const path = new URL(req.url ?? '/', 'http://statut').pathname;
        try {
            if (path === '/healthz') {
                const fresh = Math.floor(now() / 1000) - deps.lastTick() < HEALTHY_TICK_SECONDS;
                send(req, res, fresh ? 200 : 503, 'text/plain; charset=utf-8', fresh ? 'ok' : 'mesures à l’arrêt', {
                    'cache-control': 'no-store'
                });
                return;
            }
            if (path === SCRIPT_PATH) {
                if (req.headers['if-none-match'] === STATUS_SCRIPT_ETAG) {
                    res.writeHead(304, { etag: STATUS_SCRIPT_ETAG });
                    res.end();
                    return;
                }
                send(req, res, 200, 'text/javascript; charset=utf-8', STATUS_SCRIPT, {
                    etag: STATUS_SCRIPT_ETAG,
                    'cache-control': 'public, max-age=3600'
                });
                return;
            }
            if (path === ICON_PATH) {
                send(req, res, 200, 'image/png', deps.icon, { 'cache-control': 'public, max-age=86400' });
                return;
            }
            const feature = path === '/' ? null : (FEATURE_PATH.exec(path)?.[1] ?? undefined);
            const { status, html } =
                feature === undefined ? { status: 404, html: renderMissing(deps.render) } : page(path, feature);
            send(req, res, status, 'text/html; charset=utf-8', html, { 'cache-control': 'no-store' });
        } catch (e) {
            console.error('Page d’état : rendu impossible', e);
            send(req, res, 500, 'text/plain; charset=utf-8', 'Erreur interne');
        }
    });
}
