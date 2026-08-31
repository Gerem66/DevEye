import { useCallback, useEffect, useState } from 'react';
import { featureDescriptor, type FeatureId, type ItemAccess, type ItemGrantState } from '@deveye/types';

import { ws } from '@/api/ws';
import SegmentedControl from '@/Components/SegmentedControl';
import { useResourceVersion } from '@/stores/invalidation';

import styles from '../FeatureSettings.module.css';

/**
 * Ce que chaque rôle d'un espace voit de cet élément. Réutilisé par l'onglet
 * Permissions d'un élément (espace actif) et par l'onglet Partage du domicile
 * (`workspaceId` visé). Chaque ligne dit ce que le rôle voit effectivement,
 * exception ou héritage. On restreint, jamais on n'accorde : le droit du rôle
 * sur la fonctionnalité reste le plafond, l'écran des rôles reste la seule
 * réponse à « qui a accès à quoi ».
 */

const FEATURE_ACCESS_LABEL: Record<'none' | 'read' | 'write', string> = {
    none: 'aucun accès',
    read: 'lecture',
    write: 'lecture et écriture'
};

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

    const set = (roleId: number, value: ItemAccess | 'inherit'): void => {
        setBusy(true);
        setError(null);
        void ws
            .send('share.grantSet', {
                feature,
                itemId,
                workspaceId,
                roleId,
                // `null` **retire** la ligne : c'est l'absence qui exprime
                // « rien de particulier », pas une valeur neutre.
                access: value === 'inherit' ? null : value
            })
            .then(setState)
            .catch(() => setError('Modification impossible. Gérer les rôles de cet espace vous est peut-être fermé.'))
            .finally(() => setBusy(false));
    };

    if (error && !state) return <p className={styles.notice}>{error}</p>;
    if (!state) return <p className={styles.sectionHint}>Chargement…</p>;

    const noun = featureDescriptor(feature).itemNoun ?? 'élément';

    if (state.roles.length === 0) {
        return (
            <p className={styles.empty}>
                « {state.workspaceName} » n’a aucun rôle : il n’y a personne à qui restreindre l’accès de ce {noun}.
            </p>
        );
    }

    /** La phrase qui dit ce que le rôle voit, exception et héritage confondus. */
    const effectiveOf = (role: ItemGrantState['roles'][number]): string => {
        if (role.featureAccess === 'none') {
            return `Sans accès à ${featureDescriptor(feature).label} : ne le voit pas, quoi qu’on règle ici.`;
        }
        if (role.access === 'none') return 'Masqué — exception posée sur ce ' + noun + '.';
        if (role.access === 'read') return `Lecture seule — exception posée sur ce ${noun}.`;
        return `Comme la fonctionnalité : ${FEATURE_ACCESS_LABEL[role.featureAccess]}.`;
    };

    return (
        <div className={styles.grantPanel}>
            <div className={styles.channelList}>
                {state.roles.map((role) => (
                    <div key={role.roleId} className={styles.channelRow}>
                        <span className={styles.roleDot} style={{ background: role.color }} aria-hidden='true' />
                        <span className={styles.channelText}>
                            <span className={styles.channelLabel}>{role.name}</span>
                            <span className={styles.channelMeta}>{effectiveOf(role)}</span>
                        </span>
                        {/* Trois choix fixes : des boutons collés plutôt qu'un
                            déroulant. Ce que « Hérité » vaut pour ce rôle est dans
                            l'infobulle et la phrase sous son nom. */}
                        <SegmentedControl
                            value={role.access ?? 'inherit'}
                            disabled={busy || role.featureAccess === 'none'}
                            aria-label={`Accès de ${role.name} à ce ${noun}`}
                            onChange={(v) => set(role.roleId, v)}
                            options={[
                                {
                                    value: 'inherit',
                                    label: 'Hérité',
                                    title: `Comme la fonctionnalité : ${FEATURE_ACCESS_LABEL[role.featureAccess]}`
                                },
                                {
                                    value: 'read',
                                    label: 'Lecture seule',
                                    title: 'Consulter ce ' + noun + ', sans le modifier'
                                },
                                { value: 'none', label: 'Masqué', title: 'Ce ' + noun + ' n’apparaît pas pour ce rôle' }
                            ]}
                        />
                    </div>
                ))}
            </div>

            {error && <p className={styles.notice}>{error}</p>}
        </div>
    );
}
