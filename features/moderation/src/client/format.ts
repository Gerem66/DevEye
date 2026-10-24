import { maybeFeatureDescriptor, type FeatureId } from '@deveye/types';

/** « il y a 3 min », « hier à 14:02 », ou la date : ce qu'une ligne de journal dit d'un instant en secondes. */
export function momentLabel(seconds: number): string {
    const date = new Date(seconds * 1000);
    const elapsed = Date.now() - date.getTime();
    if (elapsed < 60_000) return 'à l’instant';
    if (elapsed < 3_600_000) return `il y a ${Math.floor(elapsed / 60_000)} min`;
    if (elapsed < 86_400_000) return `il y a ${Math.floor(elapsed / 3_600_000)} h`;
    return date.toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/** Le nom d'une fonctionnalité d'après son id, ou l'id d'un module qui n'est plus installé. */
export function featureName(id: string): string {
    return maybeFeatureDescriptor(id as FeatureId)?.label ?? id;
}

/** Une empreinte tient sur une ligne : ses premiers et derniers caractères suffisent à la reconnaître. */
export function shortHash(hash: string): string {
    return hash.length <= 16 ? hash : `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export const plural = (n: number, one: string, many: string): string =>
    `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;
