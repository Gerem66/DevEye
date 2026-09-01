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
 * domicile (`workspaceId` visé). Chaque ligne dit ce que le rôle obtient
 * effectivement, surcharge ou héritage.
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
            .catch(() => setError('Modification impossible. Gérer les rôles de cet espace vous est peut-être fermé.'))
            .finally(() => setBusy(false));
    };

    // `null` **retire** l'exception : c'est l'absence qui exprime « rien de
    // particulier », pas une valeur neutre.
    const set = (roleId: number, value: ItemAccess | 'inherit'): void =>
        send(roleId, { access: value === 'inherit' ? null : value });

    /**
     * Un clic pose la surcharge inverse de l'héritage, le suivant la retire. Deux
     * états au clic pour trois états possibles : « hérité » est celui qu'on
     * retrouve, jamais celui qu'on vise.
     */
    const cycleExtra = (role: ItemGrantState['roles'][number], key: string, inherited: boolean): void => {
        const next = { ...role.extraOverrides };
        if (key in next) delete next[key];
        else next[key] = !inherited;
        send(role.roleId, { extraOverrides: next });
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
        if (role.access === 'none') return `Masqué — surcharge posée sur ce ${noun}.`;
        if (role.access === 'read') return `Lecture seule — surcharge posée sur ce ${noun}.`;
        if (role.access === 'write') return `Lecture et écriture — surcharge posée sur ce ${noun}.`;
        return `Comme la fonctionnalité : ${FEATURE_ACCESS_LABEL[role.featureAccess]}.`;
    };

    /**
     * Les permissions propres de la fonctionnalité, rôle par rôle : toutes, et
     * dans les deux sens. Le rôle donne la valeur héritée, l'élément la
     * surcharge — on peut confier le terminal sur CETTE machine à un rôle qui ne
     * l'a nulle part ailleurs, ou le lui retirer ici seulement.
     */
    const extraChips = (role: ItemGrantState['roles'][number]) => {
        if (state.extras.length === 0 || role.featureAccess === 'none') return null;
        const hiddenHere = role.access === 'none';
        return (
            <div className={styles.grantExtras}>
                {state.extras.map((spec) => {
                    const inherited = role.featureExtras.includes(spec.key);
                    const forced = role.extraOverrides[spec.key];
                    const on = (forced ?? inherited) && !hiddenHere;
                    const overridden = forced !== undefined;
                    const title = hiddenHere
                        ? `Ce ${noun} est masqué pour « ${role.name} » : rien ne s’ouvre.`
                        : overridden
                          ? `${on ? 'Accordée' : 'Retirée'} sur ce ${noun} seulement. Cliquer pour revenir à ${featureDescriptor(feature).label}.`
                          : `Suit ${featureDescriptor(feature).label} (${inherited ? 'accordée' : 'refusée'}). Cliquer pour ${inherited ? 'la retirer' : 'l’accorder'} sur ce ${noun}.`;
                    return (
                        <button
                            key={spec.key}
                            type='button'
                            className={`${styles.grantChip} ${on ? styles.grantChipOn : ''} ${
                                overridden ? styles.grantChipForced : ''
                            }`}
                            aria-pressed={on}
                            aria-disabled={hiddenHere}
                            disabled={busy}
                            title={title}
                            onClick={() => {
                                if (hiddenHere) return;
                                cycleExtra(role, spec.key, inherited);
                            }}
                        >
                            <span className={`icon ${on ? 'icon-v' : 'icon-x'} ${styles.grantChipIcon}`} />
                            {spec.label}
                        </button>
                    );
                })}
            </div>
        );
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
                            {extraChips(role)}
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
                                { value: 'none', label: 'Masqué', title: `Ce ${noun} n’apparaît pas pour ce rôle` },
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
                ))}
            </div>

            {error && <p className={styles.notice}>{error}</p>}
        </div>
    );
}
