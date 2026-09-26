import type { UptimeKind } from '../contracts/domain';

/** Les deux types de contrôle, dans l'ordre du sélecteur. */
export const KIND_OPTIONS: { value: UptimeKind; label: string; title: string }[] = [
    { value: 'http', label: 'Disponibilité', title: 'L’adresse répond' },
    { value: 'integrity', label: 'Intégrité', title: 'Les fichiers servis n’ont pas changé' }
];

/** La zone « un chemin par ligne » en liste : vides et doublons écartés. */
export function parsePaths(text: string): string[] {
    return [
        ...new Set(
            text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
        )
    ];
}
