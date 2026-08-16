import { useCallback, useEffect, useState } from 'react';

import { ws } from '@/api/ws';
import { Button } from '@/Components';
import type { FeatureProps } from '@/Features/types';
import { acquireCloudSync } from '@/stores/cloudSync';
import { invalidate } from '@/stores/invalidation';
import ConfirmPopup from './ConfirmPopup';
import ShareCard from './ShareCard';
import ShareSetupWizard from './ShareSetupWizard';
import { useShares } from './useShares';
import styles from './style.module.css';
import { useLiveOutlines } from '@/live/useLiveOutline';
import { useLiveSegment } from '@/live/useLiveSegment';

export { default as CloudSyncWidget } from './CloudSyncWidget';

/**
 * CloudSync — vue pleine, volontairement minimale : une carte par partage
 * avec son héros d'état ; tout le reste (appareils, exclusions, versions,
 * réglages) vit dans des dialogues.
 */
export default function CloudSync(_props: FeatureProps) {
    const { shares, applyOrder } = useShares();
    const [wizardOpen, setWizardOpen] = useState(false);
    /** Le partage dont un dialogue est ouvert — le niveau profond de CloudSync. */
    const [openShareId, setOpenShareId] = useState<number | null>(null);
    useLiveSegment('l1', openShareId === null ? null : String(openShareId));
    const outlineOf = useLiveOutlines('l1');
    // Stable : une identité changeante relancerait l'effet de chaque carte.
    //
    // La fermeture porte l'identifiant de la carte qui se ferme, et n'efface que
    // si c'est bien elle qui était ouverte : sans ça, l'ordre des effets entre la
    // carte qu'on quitte et celle qu'on ouvre déciderait du résultat.
    const handleOpenChange = useCallback((shareId: number, open: boolean) => {
        setOpenShareId((prev) => (open ? shareId : prev === shareId ? null : prev));
    }, []);

    const refresh = useCallback(() => invalidate('cloudSync.listShares'), []);

    /**
     * Échange un partage avec son voisin. Appliqué localement d'abord, pour que
     * la carte bouge sous le clic ; un échec revient à l'ordre du serveur, seul
     * ordre réellement vrai.
     *
     * L'envoi porte la liste COMPLÈTE et non le seul couple échangé : c'est ce
     * qui rend l'opération idempotente et réparatrice — deux partages ayant
     * hérité du même rang se retrouvent départagés au premier déplacement.
     */
    const move = useCallback(
        (shareId: number, delta: -1 | 1) => {
            if (shares === null) return;
            const from = shares.findIndex((s) => s.id === shareId);
            const to = from + delta;
            if (from === -1 || to < 0 || to >= shares.length) return;
            const ids = shares.map((s) => s.id);
            [ids[from], ids[to]] = [ids[to], ids[from]];
            applyOrder(ids);
            ws.send('cloudSync.reorderShares', { ids }).catch(refresh);
        },
        [shares, applyOrder, refresh]
    );

    // Abonnement live à tous les partages affichés (progression + états).
    useEffect(() => {
        if (!shares || shares.length === 0) return;
        return acquireCloudSync(shares.map((s) => s.id));
    }, [shares]);

    if (shares === null) {
        return (
            <div className={styles.centered}>
                <span className={`icon icon-spinner ${styles.emptyIcon} ${styles.spinning}`} />
                Chargement…
            </div>
        );
    }

    return (
        <div className={styles.root}>
            {shares.length === 0 ? (
                <div className={styles.centered}>
                    <span className={`icon icon-cloud ${styles.emptyIcon}`} />
                    <div>
                        Un dossier « cloud » géré par DevEye, synchronisé entre tes appareils —<br />
                        avec versions restaurables à chaque écrasement ou suppression.
                    </div>
                    <Button icon='add' onClick={() => setWizardOpen(true)}>
                        Créer un dossier cloud
                    </Button>
                </div>
            ) : (
                <>
                    {shares.map((share, index) => (
                        <ShareCard
                            key={share.id}
                            share={share}
                            onChanged={refresh}
                            onOpenChange={handleOpenChange}
                            outline={outlineOf(String(share.id))}
                            // `null` = pas de voisin de ce côté : la flèche
                            // s'affiche désactivée plutôt que de disparaître,
                            // pour que le coin ne change pas de forme.
                            onMoveUp={index === 0 ? null : () => move(share.id, -1)}
                            onMoveDown={index === shares.length - 1 ? null : () => move(share.id, 1)}
                        />
                    ))}
                    <div className={styles.actions}>
                        <Button variant='ghost' icon='add' onClick={() => setWizardOpen(true)}>
                            Nouveau partage
                        </Button>
                    </div>
                </>
            )}
            <ShareSetupWizard
                open={wizardOpen}
                onClose={() => setWizardOpen(false)}
                onCreated={() => {
                    setWizardOpen(false);
                    refresh();
                }}
            />
            <ConfirmPopup />
        </div>
    );
}
