import { WsError } from '@/api/ws';
import { ensureUnlocked as ensureSecrecyUnlocked, touchSecrecy } from '@/stores/secrecy';
import type { ProjectPriority, ProjectStatus, ProjectTagKind } from '@deveye/types';

/**
 * Joue un appel qui touche un projet **confidentiel** et, si la couche de
 * chiffrement par mot de passe répond `locked`, ouvre l'invite globale puis
 * rejoue une fois. Calqué sur Notes et Mot de passe.
 *
 * Le portefeuille et les compteurs n'en ont pas besoin : ils ne lisent que
 * l'étage ouvert (un projet gardé y revient masqué), et c'est pour ça que la
 * feature s'ouvre sans jamais demander de mot de passe.
 */
export async function withSecrecy<T>(run: () => Promise<T>): Promise<T> {
    try {
        const out = await run();
        touchSecrecy();
        return out;
    } catch (e) {
        if (e instanceof WsError && e.code === 'locked') {
            await ensureSecrecyUnlocked();
            const out = await run();
            touchSecrecy();
            return out;
        }
        throw e;
    }
}

/** Transforme un échec WS en message court pour un bandeau d'erreur. */
export function humanizeError(e: unknown, fallback: string): string {
    if (e instanceof WsError) {
        if (e.code === 'locked') return 'Déverrouillage requis.';
        if (e.code === 'forbidden') return 'Accès refusé.';
        if (e.code === 'validation') return e.message;
        if (e.code === 'not_found') return 'Projet introuvable.';
    }
    return fallback;
}

export const STATUS_LABELS: Record<ProjectStatus, string> = {
    draft: 'Brouillon',
    active: 'En cours',
    paused: 'En pause',
    done: 'Terminé'
};

export const TAG_KIND_LABELS: Record<ProjectTagKind, string> = {
    type: 'Type',
    tech: 'Techno'
};

export const PRIORITY_LABELS: Record<ProjectPriority, string> = {
    none: 'Aucune',
    low: 'Basse',
    normal: 'Normale',
    high: 'Haute'
};

/** Date courte à la française, ou `null` si l'échéance n'est pas posée. */
export function formatDate(seconds: number | null): string | null {
    if (seconds === null) return null;
    return new Date(seconds * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** `<input type="date">` ⇄ secondes unix, en heure locale. */
export function dateInputValue(seconds: number | null): string {
    if (seconds === null) return '';
    const d = new Date(seconds * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dateInputToSeconds(value: string): number | null {
    if (!value) return null;
    const ms = new Date(`${value}T00:00:00`).getTime();
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
