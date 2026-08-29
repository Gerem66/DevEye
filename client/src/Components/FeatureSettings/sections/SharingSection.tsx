import { useCallback, useEffect, useState } from 'react';
import { featureDescriptor, type ItemShareState, type ShareBlocker } from '@deveye/types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import Switch from '@/Components/Switch';
import { moduleManifest } from '@/sdk/registry';
import { invalidate, type ResourceKey } from '@/stores/invalidation';

import { numericItemId, type SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';
import { goToItemSettings } from '../goToHome';
import ItemGrantsPanel from './ItemGrantsPanel';

/**
 * Où cet élément est visible : ses espaces, et seulement les siens. La case
 * projette, elle ne déplace pas : l'élément garde un domicile et reste chiffré
 * sous la clé de son origine. Proposer les espaces d'autrui contournerait
 * l'appartenance ; le serveur le refuse aussi.
 */

const BLOCKER_TEXT: Record<ShareBlocker, string> = {
    feature:
        'Cette fonctionnalité ne se partage pas encore entre espaces : son listage ne sait pas aller chercher les éléments projetés.',
    item: 'Cet élément est chiffré au palier « gardé ». Le serveur ne peut pas le relire pour un autre espace, et il n’est donc pas projetable — passez-le au palier ouvert si sa nature s’y prête.',
    forbidden: 'Vous n’avez pas le droit de partager les éléments de cette fonctionnalité.',
    foreign:
        'Cet élément vient d’un autre espace, où vous n’avez pas le droit de le modifier : son partage se règle par ceux qui l’ont. Qui tient l’écriture de l’élément chez lui peut, en revanche, régler son partage d’ici.'
};

interface Props {
    scope: SettingsScope;
}

export default function SharingSection({ scope }: Props) {
    const feature = scope.feature;
    const [state, setState] = useState<ItemShareState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** L'espace dont on règle les permissions ; `null` = aucun dialogue ouvert. */
    const [grantsFor, setGrantsFor] = useState<{ workspaceId: number; workspaceName: string } | null>(null);

    const itemId = numericItemId(scope) ?? 0;

    const reload = useCallback(async () => {
        const res = await ws.send('share.get', { feature, itemId });
        setState(res);
    }, [feature, itemId]);

    useEffect(() => {
        void reload().catch(() => setError('Chargement impossible.'));
    }, [reload]);

    const toggle = (workspaceId: number, shared: boolean): void => {
        setBusy(true);
        setError(null);
        void ws
            .send('share.set', { feature, itemId, workspaceId, shared })
            .then((res) => {
                setState(res);
                // La liste de la fonctionnalité change des deux côtés : on ravive
                // toutes les ressources que le manifest du module déclare, le
                // même geste que son sujet live.
                for (const key of moduleManifest(feature)?.resources ?? []) invalidate(key as ResourceKey);
            })
            .catch(() => setError('Modification impossible.'))
            .finally(() => setBusy(false));
    };

    if (!state) return <p className={styles.sectionHint}>Chargement…</p>;

    const noun = featureDescriptor(scope.feature).itemNoun ?? 'élément';

    // Sans le droit de régler le partage, on dit seulement où l'élément est
    // visible et pourquoi ça ne se règle pas d'ici.
    if (state.blocker === 'forbidden' || state.blocker === 'foreign') {
        const visible = state.workspaces.filter((w) => w.shared).map((w) => w.workspaceName);
        // Le domicile, s'il est parmi les espaces de l'appelant : c'est là que
        // le partage se règle, on propose d'y aller.
        const home = state.workspaces.find((w) => w.isHome) ?? null;
        return (
            <div className={styles.section}>
                <p className={styles.sectionHint}>
                    {visible.length > 1
                        ? `Ce ${noun} est visible dans : ${visible.join(', ')}.`
                        : `Ce ${noun} n’est visible que dans ${visible[0] ?? 'cet espace'}.`}
                </p>
                <p className={styles.sectionHint}>
                    {BLOCKER_TEXT[state.blocker]}
                    {state.blocker === 'foreign' && home !== null && (
                        <>
                            {' '}
                            <button
                                type='button'
                                className={styles.jumpBtn}
                                onClick={() => goToItemSettings(home.workspaceId, feature, itemId, 'sharing')}
                            >
                                Régler dans « {home.workspaceName} »
                            </button>
                        </>
                    )}
                </p>
            </div>
        );
    }

    return (
        <div className={styles.section}>
            <p className={styles.sectionHint}>
                Les espaces où ce {noun} est visible. Il n’y est pas copié : il reste chez lui et s’affiche ailleurs,
                donc le modifier d’un côté le modifie partout.
            </p>

            {state.blocker && <p className={styles.warning}>{BLOCKER_TEXT[state.blocker]}</p>}

            <div className={styles.channelList}>
                {state.workspaces.map((w) => (
                    <div key={w.workspaceId} className={styles.channelRow}>
                        <Switch
                            checked={w.shared}
                            aria-label={
                                w.isHome
                                    ? `${w.workspaceName} — espace d’origine`
                                    : `Rendre visible dans ${w.workspaceName}`
                            }
                            // L'origine n'est pas décochable : l'élément y est
                            // chez lui, pas projeté.
                            disabled={w.isHome || busy || state.blocker !== null}
                            onChange={(on) => toggle(w.workspaceId, on)}
                        />
                        <span className={styles.channelText}>
                            <span className={styles.channelLabel}>
                                {w.workspaceName}
                                {w.isHome && <span className={styles.channelOff}>espace d’origine</span>}
                            </span>
                            {w.isHome && (
                                <span className={styles.channelMeta}>
                                    C’est ici que la donnée vit et qu’elle est chiffrée.
                                </span>
                            )}
                        </span>
                        {/* Régler ce que chaque rôle de cet espace voit de
                            l'élément, sans y basculer : le même panneau que son
                            onglet Permissions. Le serveur dit qui peut
                            (`grantsManageable`). */}
                        {w.grantsManageable && (
                            <Button
                                variant='ghost'
                                icon='lock'
                                onClick={() =>
                                    setGrantsFor({ workspaceId: w.workspaceId, workspaceName: w.workspaceName })
                                }
                            >
                                Permissions
                            </Button>
                        )}
                    </div>
                ))}
            </div>

            <p className={styles.sectionHint}>
                Un membre d’un autre espace verra ce {noun}, mais pas ce à quoi il est relié ici — un compte mail, un
                canal d’alerte. Ces liens lui apparaissent comme « d’un autre espace », sans leur contenu.
            </p>

            {error && <p className={styles.notice}>{error}</p>}

            {/* Empilé au-dessus des réglages : il possède alors la couche de
                fermeture, donc Échap le referme sans emporter le dialogue de
                réglages derrière. */}
            <Dialog
                open={grantsFor !== null}
                onClose={() => setGrantsFor(null)}
                title={grantsFor ? `Permissions — ${grantsFor.workspaceName}` : ''}
                description={`Ce que chaque rôle de cet espace voit de ce ${noun}. On ne peut qu’abaisser ce que son rôle y donne.`}
                width={560}
            >
                {grantsFor && <ItemGrantsPanel feature={feature} itemId={itemId} workspaceId={grantsFor.workspaceId} />}
            </Dialog>
        </div>
    );
}
