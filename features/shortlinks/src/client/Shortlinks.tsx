import {
    Button,
    CountBadge,
    FeatureSettingsButton,
    PlanPausedNotice,
    StickyHeader,
    useActiveWorkspace,
    useLiveItemTarget,
    useResource,
    useSubView,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';
import { useState } from 'react';

import { api } from './api';
import LinkDetail from './LinkDetail';
import LinkDialog from './LinkDialog';
import LinkList from './LinkList';
import StatsBlock from './StatsBlock';
import UsageNotice from './UsageNotice';
import styles from './style.module.css';

/**
 * Les liens courts de l'espace : l'usage de l'offre, les visites de tous les
 * liens, puis la liste ; un lien ouvert remplace l'accueil par sa fiche. La
 * présence `l1` appartient au lien ouvert : c'est ce que la téléportation écrit.
 */
export default function Shortlinks(_props: FeatureViewProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('shortlinks', 'write');
    const workspaceId = useActiveWorkspace()?.id ?? null;
    const [openedId, setOpenedId] = useState<number | null>(null);
    const [adding, setAdding] = useState(false);

    const list = useResource(
        'shortlinks.list',
        () => api.send('shortlinks.list', {}),
        'Les liens n’ont pas pu être lus.',
        [workspaceId]
    );
    const links = list.data?.links ?? [];

    useLiveItemTarget('l1', openedId === null ? null : String(openedId), list.data !== null, (value) => {
        if (value === null) {
            setOpenedId(null);
            return;
        }
        const id = Number(value);
        if (Number.isInteger(id) && links.some((link) => link.id === id)) setOpenedId(id);
    });
    useSubView(openedId === null ? null : 'link');

    if (openedId !== null) {
        return (
            <LinkDetail
                key={openedId}
                linkId={openedId}
                canWrite={permissions.canFeature('shortlinks', 'write', String(openedId))}
                onBack={() => setOpenedId(null)}
            />
        );
    }

    return (
        <div className={styles.root}>
            <StickyHeader>
                <header className={styles.header}>
                    <div>
                        <h2 className={styles.heading}>Liens courts</h2>
                        <p className={styles.subheading}>
                            Des adresses courtes qui mènent où vous voulez, et comptent qui passe.
                        </p>
                    </div>
                    <div className={styles.actions}>
                        <FeatureSettingsButton scope={{ kind: 'feature', feature: 'shortlinks' }} />
                        {canWrite && (
                            <Button icon='add' onClick={() => setAdding(true)}>
                                Nouveau lien
                            </Button>
                        )}
                    </div>
                </header>
            </StickyHeader>

            {list.error !== null && <p className={styles.error}>{list.error}</p>}
            <UsageNotice usage={list.data?.usage ?? null} />
            <PlanPausedNotice
                count={links.filter((link) => link.status === 'planPaused' && !link.foreign).length}
                one='lien court'
                many='liens courts'
            />

            {list.data === null ? (
                list.error === null && <p className={styles.empty}>Chargement…</p>
            ) : links.length === 0 ? (
                <div className={styles.emptyState}>
                    <p className={styles.emptyTitle}>Aucun lien court pour l’instant</p>
                    <p className={styles.emptyText}>
                        Un lien court remplace une longue adresse par une courte, facile à partager dans un message, sur
                        une affiche ou en QR code. Chaque visite est comptée : vous voyez combien de personnes l’ont
                        suivi, d’où et sur quel appareil.
                    </p>
                    {canWrite ? (
                        <Button icon='add' onClick={() => setAdding(true)}>
                            Nouveau lien
                        </Button>
                    ) : (
                        <p className={styles.emptyText}>Un membre autorisé à modifier Liens courts peut en créer un.</p>
                    )}
                </div>
            ) : (
                <>
                    <StatsBlock linkId={null} title='Visites de tous vos liens' detailed={false} />
                    <section className={styles.section}>
                        <div className={styles.sectionHead}>
                            <h3 className={styles.sectionTitle}>
                                Liens <CountBadge count={links.length} tone='neutral' />
                            </h3>
                        </div>
                        <LinkList links={links} onOpen={setOpenedId} />
                    </section>
                </>
            )}

            <LinkDialog open={adding} onClose={() => setAdding(false)} onCreated={(id) => setOpenedId(id)} />
        </div>
    );
}
