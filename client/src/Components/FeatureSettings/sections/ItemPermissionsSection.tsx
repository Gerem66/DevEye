import { useCallback, useEffect, useState } from 'react';
import { featureDescriptor, type ItemAccess, type ItemRoleGrant, type WorkspaceRole } from 'deveye-types';

import { ws } from '@/api/ws';
import SelectInput from '@/Components/SelectInput';
import { invalidate, useResourceVersion } from '@/stores/invalidation';

import type { SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';

/**
 * Ce que chaque rôle voit **de cet élément**.
 *
 * ## Restreindre, jamais accorder
 *
 * Les trois choix sont « comme la fonctionnalité », « lecture seule » et
 * « masqué ». Il n'y a pas de quatrième qui ouvrirait : le droit du rôle sur la
 * fonctionnalité reste le plafond.
 *
 * L'alternative — permettre d'élever — a été écartée pour une raison précise :
 * l'accès effectif à une fonctionnalité deviendrait « le maximum entre le rôle
 * et le meilleur droit d'élément ». L'écran des rôles ne dirait alors plus à lui
 * seul qui voit quoi, et il faudrait parcourir chaque élément de l'espace pour
 * répondre à « qui a accès à Uptime ? ».
 *
 * ## Une liste et pas une grille
 *
 * Contrairement à la matrice de la fonctionnalité, il n'y a ici qu'une colonne :
 * cet élément. Une grille à une colonne n'est qu'une liste, avec des traits en
 * plus.
 */

const CHOICES: { value: ItemAccess | 'inherit'; label: string; hint: string }[] = [
    { value: 'inherit', label: 'Comme la fonctionnalité', hint: 'Aucune exception : ce que le rôle a ailleurs.' },
    { value: 'read', label: 'Lecture seule', hint: 'Le rôle le voit sans pouvoir le modifier.' },
    { value: 'none', label: 'Masqué', hint: 'Le rôle ne le voit pas du tout dans la liste.' }
];

interface Props {
    scope: SettingsScope;
}

export default function ItemPermissionsSection({ scope }: Props) {
    const version = useResourceVersion('workspace.roleList');
    const [roles, setRoles] = useState<WorkspaceRole[]>([]);
    const [grants, setGrants] = useState<ItemRoleGrant[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const itemId = scope.kind === 'item' ? scope.itemId : 0;

    const reload = useCallback(async () => {
        const [roleRes, grantRes] = await Promise.all([
            ws.send('workspace.roleList', {}),
            ws.send('share.grantList', { feature: scope.feature, itemId })
        ]);
        setRoles(roleRes.roles);
        setGrants(grantRes.grants);
    }, [scope.feature, itemId]);

    useEffect(() => {
        void reload().catch(() => setError('Chargement impossible.'));
    }, [reload, version]);

    const set = (roleId: number, value: ItemAccess | 'inherit'): void => {
        setBusy(true);
        setError(null);
        void ws
            .send('share.grantSet', {
                feature: scope.feature,
                itemId,
                roleId,
                // `null` **retire** la ligne : c'est l'absence qui exprime
                // « rien de particulier », pas une valeur neutre.
                access: value === 'inherit' ? null : value
            })
            .then((res) => {
                setGrants(res.grants);
                invalidate('workspace.roleList');
            })
            .catch(() => setError('Modification impossible.'))
            .finally(() => setBusy(false));
    };

    const noun = featureDescriptor(scope.feature).itemNoun ?? 'élément';
    const valueOf = (roleId: number): ItemAccess | 'inherit' =>
        grants.find((g) => g.roleId === roleId)?.access ?? 'inherit';

    if (roles.length === 0) {
        return (
            <p className={styles.empty}>
                Cet espace n’a aucun rôle : il n’y a personne à qui restreindre l’accès de ce {noun}.
            </p>
        );
    }

    return (
        <div className={styles.section}>
            <p className={styles.sectionHint}>
                Une exception par rôle sur ce {noun}. On ne peut qu’abaisser : un rôle sans accès à{' '}
                {featureDescriptor(scope.feature).label} ne peut pas le recevoir ici.
            </p>

            <div className={styles.channelList}>
                {roles.map((role) => (
                    <div key={role.id} className={styles.channelRow}>
                        <span className={styles.roleDot} style={{ background: role.color }} aria-hidden='true' />
                        <span className={styles.channelText}>
                            <span className={styles.channelLabel}>{role.name}</span>
                            <span className={styles.channelMeta}>
                                {CHOICES.find((c) => c.value === valueOf(role.id))?.hint}
                            </span>
                        </span>
                        <SelectInput
                            className={styles.grantSelect}
                            value={valueOf(role.id)}
                            disabled={busy}
                            aria-label={`Accès de ${role.name} à ce ${noun}`}
                            onChange={(e) => set(role.id, e.target.value as ItemAccess | 'inherit')}
                        >
                            {CHOICES.map((c) => (
                                <option key={c.value} value={c.value}>
                                    {c.label}
                                </option>
                            ))}
                        </SelectInput>
                    </div>
                ))}
            </div>

            {error && <p className={styles.notice}>{error}</p>}
        </div>
    );
}
