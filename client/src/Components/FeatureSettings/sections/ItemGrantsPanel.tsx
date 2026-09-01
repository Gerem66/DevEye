import { useCallback, useEffect, useState } from 'react';
import {
    featureDescriptor,
    type FeatureId,
    type ItemAccess,
    type ItemExtraOverrides,
    type ItemGrantState
} from '@deveye/types';

import { ws } from '@/api/ws';
import SegmentedControl from '@/Components/SegmentedControl';
import { useResourceVersion } from '@/stores/invalidation';

import styles from '../FeatureSettings.module.css';

/**
 * Ce que chaque rôle d'un espace peut faire de cet élément. Réutilisé par
 * l'onglet Permissions d'un élément (espace actif) et par l'onglet Partage du
 * domicile (`workspaceId` visé).
 *
 * La forme est celle de l'éditeur de rôle, à dessein : on y règle les mêmes
 * droits, à une autre échelle. Un bloc par rôle, le niveau d'abord, puis les
 * permissions de la fonctionnalité — chacune sur le même sélecteur à segments,
 * où « Hérité » est une valeur comme les autres et non un état à deviner.
 *
 * La surcharge va dans les deux sens : ce que la fonctionnalité donne n'est
 * qu'un défaut. Un plancher demeure, le rôle doit avoir au moins la lecture sur
 * la fonctionnalité, sans quoi l'élément n'existe pas pour lui.
 */

const FEATURE_ACCESS_LABEL: Record<'none' | 'read' | 'write', string> = {
    none: 'aucun accès',
    read: 'lecture',
    write: 'lecture et écriture'
};

/** La valeur d'un segment de permission : hériter, ou forcer dans un sens. */
type ExtraChoice = 'deny' | 'inherit' | 'allow';

interface Props {
    feature: FeatureId;
    itemId: string;
    /** L'espace visé ; absent = l'espace actif. */
    workspaceId?: number;
}

export default function ItemGrantsPanel({ feature, itemId, workspaceId }: Props) {
    // Les rôles peuvent changer sous le panneau (création, renommage) : la clé
    // de la liste des rôles sert de signal de relecture.
    const version = useResourceVersion('workspace.roleList');
    const [state, setState] = useState<ItemGrantState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        const res = await ws.send('share.grantList', { feature, itemId, workspaceId });
        setState(res);
        setError(null);
    }, [feature, itemId, workspaceId]);

    useEffect(() => {
        void reload().catch(() => setError('Chargement impossible.'));
    }, [reload, version]);

    /** Un volet à la fois : l'autre reste tel quel côté serveur. */
    const send = (roleId: number, patch: { access?: ItemAccess | null; extraOverrides?: ItemExtraOverrides }): void => {
        setBusy(true);
        setError(null);
        void ws
            .send('share.grantSet', { feature, itemId, workspaceId, roleId, ...patch })
            .then(setState)
            .catch(() =>
                setError('Modification impossible. Régler les permissions de cet espace vous est peut-être fermé.')
            )
            .finally(() => setBusy(false));
    };

    // `null` **retire** la surcharge : c'est l'absence qui exprime « comme la
    // fonctionnalité », pas une valeur neutre.
    const setAccess = (roleId: number, value: ItemAccess | 'inherit'): void =>
        send(roleId, { access: value === 'inherit' ? null : value });

    const setExtra = (role: ItemGrantState['roles'][number], key: string, choice: ExtraChoice): void => {
        const next = { ...role.extraOverrides };
        if (choice === 'inherit') delete next[key];
        else next[key] = choice === 'allow';
        send(role.roleId, { extraOverrides: next });
    };

    if (error && !state) return <p className={styles.notice}>{error}</p>;
    if (!state) return <p className={styles.sectionHint}>Chargement…</p>;

    const label = featureDescriptor(feature).label;
    const noun = featureDescriptor(feature).itemNoun ?? 'élément';

    if (state.roles.length === 0) {
        return (
            <p className={styles.empty}>
                « {state.workspaceName} » n’a aucun rôle : il n’y a personne à qui régler l’accès de ce {noun}.
            </p>
        );
    }

    /** Ce que le rôle obtient au bout du compte, surcharge et héritage confondus. */
    const effectiveOf = (role: ItemGrantState['roles'][number]): string => {
        if (role.featureAccess === 'none') return `Sans accès à ${label} : cela se règle sur le rôle.`;
        if (role.access === null) return `Comme ${label} : ${FEATURE_ACCESS_LABEL[role.featureAccess]}.`;
        return `Sur ce ${noun} : ${FEATURE_ACCESS_LABEL[role.access]}.`;
    };

    return (
        <div className={styles.grantPanel}>
            {state.roles.map((role) => {
                // Le plancher : un rôle sans accès à la fonctionnalité ne peut
                // rien recevoir ici, et sa carte le dit plutôt que de disparaître.
                const floored = role.featureAccess === 'none';
                const hiddenHere = role.access === 'none';
                return (
                    <section key={role.roleId} className={styles.grantRole}>
                        <div className={styles.grantRoleHead}>
                            <span className={styles.roleDot} style={{ background: role.color }} aria-hidden='true' />
                            <span className={styles.channelText}>
                                <span className={styles.channelLabel}>{role.name}</span>
                                <span className={styles.channelMeta}>{effectiveOf(role)}</span>
                            </span>
                        </div>

                        <div className={styles.grantRoleCard}>
                            <div className={styles.grantRoleRow}>
                                <span className={styles.grantRoleLabel}>
                                    Accès
                                    {/* Ce que « Hérité » vaut ici, toujours affiché : sans
                                        lui, le segment choisi ne dit pas où il mène. */}
                                    <span className={styles.grantRoleDefault}>
                                        Défaut : {FEATURE_ACCESS_LABEL[role.featureAccess]}
                                    </span>
                                </span>
                                <SegmentedControl
                                    value={role.access ?? 'inherit'}
                                    disabled={busy || floored}
                                    aria-label={`Accès de ${role.name} à ce ${noun}`}
                                    onChange={(v) => setAccess(role.roleId, v)}
                                    options={[
                                        {
                                            value: 'none',
                                            label: 'Masqué',
                                            title: `Ce ${noun} n’apparaît pas pour ce rôle`
                                        },
                                        {
                                            value: 'inherit',
                                            label: 'Hérité',
                                            title: `Comme ${label} : ${FEATURE_ACCESS_LABEL[role.featureAccess]}`
                                        },
                                        {
                                            value: 'read',
                                            label: 'Lecture',
                                            title: `Consulter ce ${noun}, sans le modifier`
                                        },
                                        {
                                            value: 'write',
                                            label: 'Écriture',
                                            title: `Modifier ce ${noun}, même si le rôle n’a que la lecture ailleurs`
                                        }
                                    ]}
                                />
                            </div>

                            {state.extras.map((spec) => {
                                const inherited = role.featureExtras.includes(spec.key);
                                const forced = role.extraOverrides[spec.key];
                                const value: ExtraChoice = forced === undefined ? 'inherit' : forced ? 'allow' : 'deny';
                                return (
                                    <div key={spec.key} className={styles.grantRoleRow}>
                                        <span className={styles.grantRoleLabel}>
                                            {spec.label}
                                            <span className={styles.grantRoleDefault}>
                                                Défaut : {inherited ? 'accordée' : 'refusée'}
                                            </span>
                                        </span>
                                        <SegmentedControl
                                            value={value}
                                            disabled={busy || floored || hiddenHere}
                                            aria-label={`${spec.label} de ${role.name} sur ce ${noun}`}
                                            onChange={(v) => setExtra(role, spec.key, v)}
                                            options={[
                                                {
                                                    value: 'deny',
                                                    label: 'Refusée',
                                                    title: `Retirée sur ce ${noun}, même si ${label} l’accorde`
                                                },
                                                {
                                                    value: 'inherit',
                                                    label: 'Hérité',
                                                    title: `Comme ${label} : ${inherited ? 'accordée' : 'refusée'}`
                                                },
                                                {
                                                    value: 'allow',
                                                    label: 'Accordée',
                                                    title: `Accordée sur ce ${noun}, même si ${label} la refuse`
                                                }
                                            ]}
                                        />
                                    </div>
                                );
                            })}

                            {hiddenHere && state.extras.length > 0 && (
                                <p className={styles.fieldHint}>
                                    Ce {noun} est masqué pour ce rôle : ses permissions ne s’appliquent pas tant que
                                    l’accès reste fermé.
                                </p>
                            )}
                        </div>
                    </section>
                );
            })}

            {error && <p className={styles.notice}>{error}</p>}
        </div>
    );
}
