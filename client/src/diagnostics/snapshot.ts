import type { FeedbackSnapshot } from '@deveye/types';

import { ws } from '@/api/ws';
import { getActiveWorkspaceId } from '@/stores/workspace';
import { readTrace } from './trace';

/**
 * Le rapport technique joint à un signalement de bug. Assemblé à l'ouverture du
 * formulaire, pour que l'utilisateur voie exactement ce qu'il enverra avant de
 * l'envoyer.
 *
 * Tout est au conditionnel : un champ que le navigateur n'expose pas vaut
 * `null`, jamais une valeur inventée. Rien n'est demandé qui déclenche une
 * permission.
 */

/** L'API `userAgentData`, absente hors Chromium. */
interface UserAgentData {
    brands?: { brand: string; version: string }[];
    platform?: string;
    mobile?: boolean;
}

/**
 * La marque du navigateur parmi celles qu'il déclare. Chromium en annonce
 * plusieurs, dont des leurres délibérés (« Not.A/Brand ») : on prend la
 * dernière vraie, celle qui nomme le produit plutôt que le moteur.
 */
function readBrand(data: UserAgentData | undefined): { name: string | null; version: string | null } {
    const brands = (data?.brands ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand));
    const brand = brands[brands.length - 1];
    return { name: brand?.brand ?? null, version: brand?.version ?? null };
}

function mediaMatches(query: string): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

export function buildSnapshot(): FeedbackSnapshot {
    const nav = navigator as Navigator & {
        userAgentData?: UserAgentData;
        deviceMemory?: number;
    };
    const brand = readBrand(nav.userAgentData);
    const trace = readTrace();

    return {
        browser: {
            name: brand.name,
            version: brand.version,
            platform: nav.userAgentData?.platform ?? null,
            mobile: nav.userAgentData?.mobile ?? null,
            userAgent: nav.userAgent.slice(0, 500),
            language: nav.language,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            cores: nav.hardwareConcurrency ?? null,
            memoryGb: nav.deviceMemory ?? null,
            online: nav.onLine
        },
        viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            pixelRatio: window.devicePixelRatio,
            reducedMotion: mediaMatches('(prefers-reduced-motion: reduce)'),
            colorScheme: mediaMatches('(prefers-color-scheme: light)') ? 'light' : 'dark'
        },
        app: {
            clientVersion: __APP_VERSION__,
            view: trace.currentView,
            workspaceId: getActiveWorkspaceId(),
            connection: ws.state,
            sessionAgeSeconds: trace.sessionAgeSeconds,
            // Le chemin seul : la query ne porte que l'espace actif, déjà là.
            path: window.location.pathname.slice(0, 300)
        },
        requests: trace.requests,
        errors: trace.errors,
        views: trace.views
    };
}

/** Le poids réel du rapport une fois sérialisé, en octets. */
export function snapshotBytes(snapshot: FeedbackSnapshot): number {
    return new Blob([JSON.stringify(snapshot)]).size;
}
