import type { FeatureAccess, FeatureId, WorkspaceRole } from '@deveye/types';

import SegmentedControl from '@/Components/SegmentedControl';
import styles from './organize.module.css';

export type AccessChoice = FeatureAccess | 'none';

const ACCESS_OPTIONS = [
    { value: 'none', label: 'Aucun', title: 'La fonctionnalité reste fermée à ce rôle' },
    { value: 'read', label: 'Lecture', title: 'Consulter, sans rien modifier' },
    { value: 'write', label: 'Écriture', title: 'Lecture et écriture' }
] as const;

/** Les rôles qui n'ouvrent pas encore cette fonctionnalité. */
export function rolesWithout(roles: readonly WorkspaceRole[], featureId: FeatureId): WorkspaceRole[] {
    return roles.filter((r) => !r.allFeatures && !r.features.some((g) => g.feature === featureId));
}

function memberCountLabel(count: number): string {
    if (count === 0) return 'Aucun membre';
    return count === 1 ? '1 membre' : `${count} membres`;
}

export interface FeatureAccessStepProps {
    featureId: FeatureId;
    featureLabel: string;
    roles: readonly WorkspaceRole[];
    choices: Readonly<Record<number, AccessChoice>>;
    onChange: (roleId: number, choice: AccessChoice) => void;
    isOwner: boolean;
}

/**
 * Qui ouvrira la fonctionnalité qu'on pose : la question se pose au moment de
 * l'ajout, sans quoi le propriétaire, qui voit tout, ne s'aperçoit pas qu'il est
 * le seul. Rien ne s'ouvre sans geste : chaque rôle part à « Aucun ».
 */
export function FeatureAccessStep({
    featureId,
    featureLabel,
    roles,
    choices,
    onChange,
    isOwner
}: FeatureAccessStepProps) {
    const missing = rolesWithout(roles, featureId);
    const covered = roles.filter((r) => !missing.includes(r));
    const opened = missing.filter((r) => (choices[r.id] ?? 'none') !== 'none');

    return (
        <div className={styles.accessStep}>
            <p className={styles.accessLead}>
                {missing.length === 1
                    ? `Le rôle « ${missing[0].name} » n’a pas encore accès à ${featureLabel}.`
                    : `Ces rôles n’ont pas encore accès à ${featureLabel}.`}{' '}
                Ce choix se modifie ensuite dans chaque rôle.
            </p>

            <div className={styles.accessRows}>
                {missing.map((r) => (
                    <div key={r.id} className={styles.accessRow}>
                        <span className={styles.accessDot} style={{ background: r.color }} aria-hidden='true' />
                        <span className={styles.accessText}>
                            <span className={styles.accessName}>{r.name}</span>
                            <span className={styles.accessMeta}>{memberCountLabel(r.memberCount)}</span>
                        </span>
                        <SegmentedControl
                            aria-label={`Accès de ${r.name} à ${featureLabel}`}
                            value={choices[r.id] ?? 'none'}
                            options={ACCESS_OPTIONS}
                            onChange={(v) => onChange(r.id, v)}
                        />
                    </div>
                ))}
            </div>

            {covered.length > 0 && (
                <p className={styles.accessNote}>
                    {covered.map((r) => `« ${r.name} »`).join(', ')} {covered.length === 1 ? 'y a' : 'y ont'} déjà
                    accès.
                </p>
            )}
            {covered.length === 0 && opened.length === 0 && (
                <p className={styles.accessNote}>
                    {isOwner
                        ? 'En l’état, vous seul y aurez accès.'
                        : 'En l’état, seul le propriétaire de l’espace y aura accès.'}
                </p>
            )}
        </div>
    );
}
