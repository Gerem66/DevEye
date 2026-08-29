import { useEffect, useState } from 'react';
import {
    FeatureSettingsButton,
    openInfo,
    SegmentedControl,
    useActiveWorkspace,
    useCurrentUser
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import Fleet from './fleet/Fleet';
import Monitoring from './Monitoring';
import { MonitoringInfo } from './MonitoringInfo';
import { takeFleetIntent, useFleetIntent } from './navigation';
import styles from './style.module.css';

type Segment = 'monitoring' | 'fleet';

const SEGMENTS: readonly { value: Segment; label: string; title: string }[] = [
    { value: 'monitoring', label: 'Monitoring', title: 'Les appareils de cet espace, en direct et dans le temps' },
    { value: 'fleet', label: 'Flotte', title: 'Toute la flotte : appairage, approbation, révocation, partage' }
];

/**
 * La vue complète : Monitoring, et pour l'administrateur dans son espace
 * personnel un second segment, la flotte. Deux segments fixes, donc
 * `SegmentedControl` : la flotte est l'envers de la même feature, et ne
 * s'adresse qu'à l'administrateur global depuis le seul espace où elle a un sens.
 *
 * La barre du haut existe même sans second segment : c'est elle qui porte le
 * bouton commun et l'aide, à la place où chaque feature les met. Les avoir
 * rangés dans la colonne des appareils les faisait disparaître dès qu'on passait
 * à la flotte, et les cherchait ailleurs que partout ailleurs.
 */
export default function Devices(_props: FeatureViewProps) {
    const user = useCurrentUser();
    const workspace = useActiveWorkspace();
    const fleetOffered = user?.role === 'admin' && workspace?.kind === 'personal';
    const [segment, setSegment] = useState<Segment>('monitoring');

    // L'intention « ouvrir la flotte » posée par un panneau d'appareil,
    // consommée au montage comme à chaque nouvelle demande, vue visible ou parquée.
    const intent = useFleetIntent();
    useEffect(() => {
        if (takeFleetIntent()) setSegment('fleet');
    }, [intent]);

    // La flotte n'est plus offerte : on revient à Monitoring plutôt que de
    // laisser un segment orphelin.
    useEffect(() => {
        if (!fleetOffered) setSegment('monitoring');
    }, [fleetOffered]);

    return (
        <div className={styles.view}>
            <div className={styles.viewBar}>
                {fleetOffered && (
                    <SegmentedControl value={segment} options={SEGMENTS} onChange={setSegment} aria-label='Vue' />
                )}
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
                </div>
            </div>
            <div className={styles.viewBody}>{fleetOffered && segment === 'fleet' ? <Fleet /> : <Monitoring />}</div>
        </div>
    );
}
