import { featureApi } from 'deveye-sdk-client';
import type { ProjectStatus } from '@deveye/types';

import { manifest } from '../manifest';

import type { ProjectPriority, ProjectTagKind } from '../contracts/domain';

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
