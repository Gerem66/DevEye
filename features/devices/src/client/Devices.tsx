import { useState } from 'react';
import { useWorkspacePermissions } from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import { DownloadAgent } from './manage/DownloadAgent';
import { LinkCodesDialog } from './manage/LinkCodesDialog';
import { useLinkCodes } from './manage/useLinkCodes';
import Monitoring from './Monitoring';
import { refreshDevices } from './store';
import styles from './style.module.css';

/**
 * La vue complète : les appareils de l'espace et la fiche de celui qu'on
 * consulte. Elle n'a pas de barre à elle, tout tient dans la colonne de gauche ;
 * elle ne garde que l'appairage, dont le geste est rendu par la liste et les
 * dialogues montés ici. Une machine appairée ici n'apparaît qu'ici tant qu'elle
 * n'est pas partagée (onglet « Partage » de ses réglages).
 */
export default function Devices(_props: FeatureViewProps) {
    const canWrite = useWorkspacePermissions().canFeature('devices', 'write');
    const links = useLinkCodes(refreshDevices);
    const [showDownload, setShowDownload] = useState(false);

    return (
        <div className={styles.view}>
            <div className={styles.viewBody}>
                <Monitoring onPair={canWrite ? links.openLinkModal : undefined} />
            </div>
            <LinkCodesDialog links={links} onDownload={() => setShowDownload(true)} />
            <DownloadAgent open={showDownload} onClose={() => setShowDownload(false)} />
        </div>
    );
}
