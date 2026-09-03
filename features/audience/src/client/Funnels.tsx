import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, humanizeError, useResourceVersion } from 'deveye-sdk-client';
import type { AudienceFunnel, AudienceRange, AudienceSite } from '../contracts/domain';

import { api } from './api';
import FunnelDetailDialog from './FunnelDetailDialog';
import FunnelDialog from './FunnelDialog';
import RangeBar from './RangeBar';
import FunnelBar from './Stats/FunnelBar';
import styles from './style.module.css';

interface FunnelsProps {
    site: AudienceSite;
    /** Définir un entonnoir est une écriture ; le lire n'en est pas une. */
    canWrite: boolean;
    /** De quoi garnir la barre collante, comme `SiteView`. */
    heading?: ReactNode;
    actions?: ReactNode;
}

/**
 * Les entonnoirs d'un site : où les visiteurs décrochent.
 *
 * Bloc autonome, avec sa fenêtre et son chargement, parce qu'il apparaît à deux
 * endroits qui n'ont pas la même forme : une section de la fiche d'un site, et
 * un empilement sous les chiffres dans l'onglet d'un projet. Le mesurer depuis
 * le bloc voisin aurait obligé chacun à faire descendre une fenêtre qui ne le
 * concerne pas.
 */
export function Funnels({ site, canWrite, heading, actions }: FunnelsProps) {
    const [range, setRange] = useState<AudienceRange>('7d');
    const [funnels, setFunnels] = useState<AudienceFunnel[]>([]);
    /** `undefined` = fermé ; `null` = création ; un entonnoir = modification. */
    const [edit, setEdit] = useState<AudienceFunnel | null | undefined>(undefined);
    /** L'entonnoir dont on regarde le détail ; `null` = aucun. */
    const [opened, setOpened] = useState<AudienceFunnel | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const statsVersion = useResourceVersion('audience.stats');

    const load = useCallback(async () => {
        try {
            const res = await api.send('audience.funnelList', { siteId: site.id, range });
            setFunnels(res.funnels);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les entonnoirs.'));
        } finally {
            setLoading(false);
        }
    }, [site.id, range]);

    useEffect(() => {
        // Un site qui n'a jamais rien reçu ne peut avoir franchi aucune marche : la
        // requête de rétention rendrait des zéros au prix d'un balayage complet.
        if (site.lastEventAt === null) {
            setLoading(false);
            return;
        }
        setLoading(true);
        void load();
    }, [load, statsVersion, site.lastEventAt]);

    return (
        <section className={styles.panel}>
            <div className={styles.panelHead}>
                {heading ?? <h3 className={styles.panelTitle}>Entonnoirs</h3>}
                <RangeBar value={range} onChange={setRange} />
                {canWrite && (
                    <Button variant='ghost' icon='add' onClick={() => setEdit(null)}>
                        Nouvel entonnoir
                    </Button>
                )}
                {actions}
            </div>

            {error && <p className={styles.error}>{error}</p>}

            {loading && funnels.length === 0 ? (
                <p className={styles.empty}>Chargement…</p>
            ) : funnels.length === 0 ? (
                <p className={styles.empty}>
                    Aucun entonnoir. Composez-en un à partir des pages et des événements déjà mesurés pour voir où les
                    visiteurs décrochent.
                </p>
            ) : (
                <div className={styles.funnelCards}>
                    {funnels.map((funnel) => (
                        <FunnelBar key={funnel.id} funnel={funnel} onOpen={() => setOpened(funnel)} />
                    ))}
                </div>
            )}

            <FunnelDetailDialog
                funnel={opened}
                canWrite={canWrite}
                onClose={() => setOpened(null)}
                onEdit={() => {
                    // Du détail à l'édition sans repasser par la liste :
                    // « modifier » depuis un détail veut dire « celui-ci ».
                    setEdit(opened);
                    setOpened(null);
                }}
            />

            <FunnelDialog
                open={edit !== undefined}
                siteId={site.id}
                funnel={edit ?? null}
                onClose={() => setEdit(undefined)}
                onSaved={() => {
                    setEdit(undefined);
                    void load();
                }}
            />
        </section>
    );
}

export default Funnels;
