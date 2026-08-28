import { useEffect, useState } from 'react';
import { SegmentedControl, useActiveWorkspace, useCurrentUser } from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import Fleet from './fleet/Fleet';
import Monitoring from './Monitoring';
import { takeFleetIntent, useFleetIntent } from './navigation';
import styles from './style.module.css';

type Segment = 'monitoring' | 'fleet';

const SEGMENTS: readonly { value: Segment; label: string; title: string }[] = [
    { value: 'monitoring', label: 'Monitoring', title: 'Les appareils de cet espace, en direct et dans le temps' },
    { value: 'fleet', label: 'Flotte', title: 'Toute la flotte : appairage, approbation, révocation, partage' }
];

/**
 * La vue complète de la feature : Monitoring, et pour l'administrateur dans
 * son espace personnel un second segment, la flotte (l'ancienne page
 * « Appareils » de la barre du haut).
 *
 * Deux segments fixes, donc `SegmentedControl` : la flotte n'est pas une
 * autre feature, c'est l'envers de la même (les machines qu'on supervise sont
 * celles qu'on a enrôlées), et elle ne s'adresse qu'à l'administrateur global,
 * depuis le seul espace où la flotte entière a un sens. Ailleurs, la vue est
 * Monitoring tout court, sans barre.
 *
 * La vue d'un module ne reçoit que `closeFeature` ; l'espace et le rôle
 * viennent des hooks du barrel.
 */
export default function Devices(_props: FeatureViewProps) {
    const user = useCurrentUser();
    const workspace = useActiveWorkspace();
    const fleetOffered = user?.role === 'admin' && workspace?.kind === 'personal';
    const [segment, setSegment] = useState<Segment>('monitoring');

    // L'intention « ouvrir la flotte » posée par un panneau d'appareil (« Gérer
    // les appareils »), consommée ici au montage comme à chaque nouvelle
    // demande pendant que la vue vit, visible ou parquée.
    const intent = useFleetIntent();
    useEffect(() => {
        if (takeFleetIntent()) setSegment('fleet');
    }, [intent]);

    // L'espace ou le rôle change sous la vue : la flotte n'est plus offerte,
    // on revient à Monitoring plutôt que de laisser un segment orphelin.
    useEffect(() => {
        if (!fleetOffered) setSegment('monitoring');
    }, [fleetOffered]);

    if (!fleetOffered) return <Monitoring />;

    return (
        <div className={styles.view}>
            <div className={styles.viewBar}>
                <SegmentedControl value={segment} options={SEGMENTS} onChange={setSegment} aria-label='Vue' />
            </div>
            <div className={styles.viewBody}>{segment === 'fleet' ? <Fleet /> : <Monitoring />}</div>
        </div>
    );
}
