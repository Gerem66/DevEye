import { featureApi } from 'deveye-sdk-client';
import type { ProjectStatus } from '@deveye/types';

import { manifest } from '../manifest';

import type { ProjectPriority, ProjectTagKind } from '../contracts/domain';

/**
 * L'envoi typé des commandes du module, partagé par toutes ses vues.
 *
 * Le portefeuille et les compteurs s'appellent tels quels : ils ne lisent que
 * l'étage ouvert (un projet gardé y revient masqué), et c'est pour ça que la
 * feature s'ouvre sans jamais demander de mot de passe. Tout appel qui touche
 * un projet **confidentiel** passe par le `withSecrecy` du barrel, qui ouvre
 * l'invite globale sur un `locked` puis rejoue une fois ; `humanizeError`
 * vient du barrel aussi. Les deux vivaient ici du temps du natif, recopiés de
 * Notes et Mot de passe.
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
