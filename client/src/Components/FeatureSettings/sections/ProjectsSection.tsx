import { useCallback, useEffect, useState } from 'react';
import { itemNounForms, PROJECT_STATUS_LABELS, type ItemProjectsBlocker, type ItemProjectsState } from '@deveye/types';

import { humanizeError } from '@/api/useResource';
import { ws } from '@/api/ws';
import Switch from '@/Components/Switch';
import { moduleManifest } from '@/sdk/registry';
import { invalidate, type ResourceKey } from '@/stores/invalidation';

import { type SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';

/**
 * Quels projets utilisent cet élément, et l'y attacher ou l'en retirer d'ici.
 * Un groupe par espace où l'élément est visible, l'actif en tête : une liaison
 * vit dans l'espace du projet, et le même élément sert des projets de plusieurs
 * espaces à la fois sans jamais y être copié.
 *
 * Une case n'est vive que là où l'appelant tient `projects: write` ; ailleurs
 * la liste reste lisible et inerte, comme les cases d'un élément projeté dans
 * l'onglet Partage.
 */

const BLOCKER_TEXT: Record<ItemProjectsBlocker, string> = {
    module: 'Le module Projets n’est pas installé sur ce serveur : il n’y a rien à relier.',
    feature: 'Un projet ne relie pas les éléments de cette fonctionnalité.'
};

interface Props {
    scope: SettingsScope;
}

export default function ProjectsSection({ scope }: Props) {
    const feature = scope.feature;
    const itemId = scope.kind === 'item' ? scope.itemId : '';
    const [state, setState] = useState<ItemProjectsState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { dem, Dem } = itemNounForms(feature);

    const reload = useCallback(async () => {
        setState(await ws.send('links.projectsGet', { feature, itemId }));
    }, [feature, itemId]);

    useEffect(() => {
        void reload().catch(() => setError('Chargement impossible.'));
    }, [reload]);

    const toggle = (workspaceId: number, projectId: number, linked: boolean): void => {
        setBusy(true);
        setError(null);
        void ws
            .send('links.projectsSet', { feature, itemId, workspaceId, projectId, linked })
            .then((res) => {
                setState(res);
                // Le portefeuille et ses onglets d'un côté, la liste de la
                // fonctionnalité et son compteur de projets de l'autre : on
                // ravive ce que chaque manifest déclare.
                for (const key of moduleManifest('projects')?.resources ?? []) invalidate(key as ResourceKey);
                for (const key of moduleManifest(feature)?.resources ?? []) invalidate(key as ResourceKey);
            })
            .catch((e: unknown) => setError(humanizeError(e, 'Modification impossible.')))
            .finally(() => setBusy(false));
    };

    if (!state) return <p className={styles.sectionHint}>Chargement…</p>;

    if (state.blocker) {
        return (
            <div className={styles.section}>
                <p className={styles.sectionHint}>{BLOCKER_TEXT[state.blocker]}</p>
            </div>
        );
    }

    return (
        <div className={styles.section}>
            <p className={styles.sectionHint}>
                Les projets qui utilisent {dem}. {Dem} n’y est pas copié : il reste là où il vit, et un projet ne fait
                que le désigner. Un projet confidentiel ne relie rien.
            </p>

            {/* Un espace où l'appelant ne lit pas Projets n'est pas rendu du
                tout par le serveur : les titres des projets d'un espace ne se
                lisent pas de l'extérieur. */}
            {state.groups.length === 0 && (
                <p className={styles.sectionHint}>Aucun espace où {dem} est visible ne vous donne accès à Projets.</p>
            )}

            {state.groups.map((group) => (
                <div key={group.workspaceId} className={styles.projectGroup}>
                    <span className={styles.sectionLabel}>
                        {group.workspaceName}
                        {group.isActive && ' · espace actif'}
                        {!group.isHome && ` · ${dem} y est projeté`}
                    </span>

                    {!group.writable && (
                        <span className={styles.projectGroupNote}>
                            Vous ne modifiez pas les projets de cet espace : la liste est en lecture seule.
                        </span>
                    )}

                    {group.projects.length === 0 ? (
                        <span className={styles.projectGroupNote}>Aucun projet ouvert dans cet espace.</span>
                    ) : (
                        <div className={styles.channelList}>
                            {group.projects.map((p) => (
                                <div key={p.projectId} className={styles.channelRow}>
                                    <Switch
                                        checked={p.linked}
                                        aria-label={`Relier ${dem} à « ${p.title} » dans ${group.workspaceName}`}
                                        // Un projet rangé garde sa liaison
                                        // décochable, jamais recochable.
                                        disabled={busy || !group.writable || (p.archived && !p.linked)}
                                        onChange={(on) => toggle(group.workspaceId, p.projectId, on)}
                                    />
                                    <span className={styles.channelText}>
                                        <span className={styles.channelLabel}>
                                            {p.title}
                                            {p.archived && <span className={styles.channelOff}>archivé</span>}
                                        </span>
                                        <span className={styles.channelMeta}>{PROJECT_STATUS_LABELS[p.status]}</span>
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ))}

            {error && <p className={styles.notice}>{error}</p>}
        </div>
    );
}
