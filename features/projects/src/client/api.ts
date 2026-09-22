import { featureApi, WsError } from 'deveye-sdk-client';
import type { ProjectStatus } from '@deveye/types';

import { manifest } from '../manifest';

import type { ProjectCard, ProjectPriority, ProjectTagKind } from '../contracts/domain';

/**
 * L'envoi typé des commandes du module. Le portefeuille et les compteurs
 * s'appellent tels quels ; tout appel touchant un projet confidentiel passe par
 * le `withSecrecy` du barrel, qui ouvre l'invite sur un `locked` puis rejoue.
 */
export const api = featureApi(manifest);

export const STATUS_LABELS: Record<ProjectStatus, string> = {
    draft: 'Brouillon',
    active: 'En cours',
    paused: 'En pause',
    done: 'Terminé'
};

/** Les statuts, dans l'ordre où un projet les traverse. */
export const STATUSES: ProjectStatus[] = ['draft', 'active', 'paused', 'done'];

/** Côté de la vignette enregistrée, en pixels. La carte l'affiche à 36 px. */
export const PROJECT_ICON_SIZE = 128;

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

/** Tri d'affichage : l'ordre du français, accents et casse ignorés. */
export const compareFr = new Intl.Collator('fr', { sensitivity: 'base', numeric: true }).compare;

/** « il y a 3 h » : l'âge d'un instant passé, en secondes unix. */
export function relativeAgo(seconds: number, now = Math.floor(Date.now() / 1000)): string {
    const elapsed = Math.max(0, now - seconds);
    if (elapsed < 60) return 'à l’instant';
    const minutes = Math.floor(elapsed / 60);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.floor(hours / 24)} j`;
}

export function formatDateTime(seconds: number): string {
    return new Date(seconds * 1000).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Le refus d'un déplacement, nommé. Le serveur ne voit ni les titres ni les
 * libellés : il ne rend que les cartes retenues, et c'est d'ici qu'on les nomme.
 */
export function moveRefusal(error: unknown, cards: readonly ProjectCard[]): string | null {
    if (!(error instanceof WsError) || error.code !== 'conflict') return null;
    const held = (error.details as { cards?: { cardId: number }[] } | undefined)?.cards ?? [];
    const card = cards.find((c) => c.id === held[0]?.cardId);
    if (!card) return null;
    const open = card.checklist.filter((i) => i.required && !i.done).map((i) => `« ${i.label} »`);
    const named = open.length > 3 ? [...open.slice(0, 3), '…'] : open;
    const title = card.title || 'Cette tâche';
    return `« ${title} » ne peut pas être terminée : il reste ${named.join(', ')}.`;
}
