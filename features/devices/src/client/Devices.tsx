import { useState } from 'react';
import { Button, FeatureSettingsButton, openInfo, useWorkspacePermissions } from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import { DownloadAgent } from './manage/DownloadAgent';
import { LinkCodesDialog } from './manage/LinkCodesDialog';
import { useLinkCodes } from './manage/useLinkCodes';
import Monitoring from './Monitoring';
import { MonitoringInfo } from './MonitoringInfo';
import { refreshDevices } from './store';
import styles from './style.module.css';

/**
 * La vue complète : les appareils de l'espace et la fiche de celui qu'on
 * consulte. Appairer une machine se fait d'ici, sous le droit d'écriture de
 * l'espace : la liste est celle de cet espace, et une machine appairée ici n'y
 * apparaît qu'ici tant qu'elle n'est pas partagée (onglet « Partage » de ses
 * réglages).
 */
export default function Devices(_props: FeatureViewProps) {
    const canWrite = useWorkspacePermissions().canFeature('devices', 'write');
    const links = useLinkCodes(refreshDevices);
    const [showDownload, setShowDownload] = useState(false);

    return (
        <div className={styles.view}>
            <div className={styles.viewBar}>
                <div className={styles.viewBarActions}>
                    <button
                        type='button'
                        className={styles.iconHeaderBtn}
                        onClick={() =>
                            void openInfo({
                                title: 'Monitoring — comment ça marche',
                                body: <MonitoringInfo />,
                                width: 560
                            })
                        }
                        title='Comment ça marche ?'
                    >
                        <span className='icon icon-info' />
                    </button>
                    <FeatureSettingsButton scope={{ kind: 'feature', feature: 'devices' }} />
                    {canWrite && (
                        <Button icon='plus' onClick={links.openLinkModal} disabled={links.generatingCode}>
                            Appairer un appareil
                        </Button>
                    )}
                </div>
            </div>
            <div className={styles.viewBody}>
                <Monitoring />
            </div>
            <LinkCodesDialog links={links} onDownload={() => setShowDownload(true)} />
            <DownloadAgent open={showDownload} onClose={() => setShowDownload(false)} />
        </div>
    );
}
