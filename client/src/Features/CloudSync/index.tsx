import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/Components';
import type { FeatureProps } from '@/Features/types';
import { acquireCloudSync } from '@/stores/cloudSync';
import { invalidate } from '@/stores/invalidation';
import ConfirmPopup from './ConfirmPopup';
import ShareCard from './ShareCard';
import ShareSetupWizard from './ShareSetupWizard';
import { useShares } from './useShares';
import styles from './style.module.css';

export { default as CloudSyncWidget } from './CloudSyncWidget';

/**
 * CloudSync — vue pleine, volontairement minimale : une carte par partage
 * avec son héros d'état ; tout le reste (appareils, exclusions, versions,
 * réglages) vit dans des dialogues.
 */
export default function CloudSync(_props: FeatureProps) {
    const shares = useShares();
    const [wizardOpen, setWizardOpen] = useState(false);

    const refresh = useCallback(() => invalidate('cloudSync.listShares'), []);

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
                    {shares.map((share) => (
                        <ShareCard key={share.id} share={share} onChanged={refresh} />
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
