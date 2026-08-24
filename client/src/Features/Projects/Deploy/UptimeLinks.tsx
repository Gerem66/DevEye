import { useCallback, useEffect, useState } from 'react';
import type { UptimeService } from '@deveye/types';
import { Button } from '@/Components';
import { ws, WsError } from '@/api/ws';
import { useWorkspacePermissions } from '@/stores/workspace';
import deployStyles from '@/Features/Deploy/style.module.css';
import { humanizeError } from '../api';
import { LinkUptimeDialog } from './LinkUptimeDialog';
import { UptimeLinkRow } from './UptimeLinkRow';
import styles from '../style.module.css';

interface UptimeLinksProps {
    projectId: number;
    canWrite: boolean;
}

/**
 * Les services surveillés que ce projet rattache.
 *
 * Ils vivent dans l'onglet Déploiement, et nulle part ailleurs : c'est
 * l'endroit où l'on se demande si ce qui vient d'être livré tient debout, donc
 * l'endroit où « est-ce en ligne ? » est la question suivante. Un panneau
 * générique posé sur tous les onglets, comme l'ancien « Liens DevEye »,
 * répondait à cette question partout — c'est-à-dire nulle part.
 *
 * **Chaque feature garde ses droits.** Le serveur ne rend que des identifiants ;
 * les noms et les états viennent d'`uptime.list`, appelée au nom de
 * l'utilisateur. Un membre sans accès à Uptime voit donc qu'il y a des services
 * rattachés, sans pouvoir les nommer — plutôt que de les voir disparaître.
 */
export function UptimeLinks({ projectId, canWrite }: UptimeLinksProps) {
    const permissions = useWorkspacePermissions();
    const canReadUptime = permissions.canFeature('uptime');
    const canWriteUptime = permissions.canFeature('uptime', 'write');
    const [serviceIds, setServiceIds] = useState<number[]>([]);
    const [services, setServices] = useState<UptimeService[] | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await ws.send('project.uptimeList', { projectId });
            setServiceIds(res.serviceIds);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les services rattachés.'));
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    // Le catalogue, pour nommer les rattachés et proposer les autres. Un refus
    // de droit n'est pas une erreur à afficher : il dit « tu ne peux pas choisir
    // ici », et la liste retombe sur des identifiants nus.
    useEffect(() => {
        if (!canReadUptime) {
            setServices([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const res = await ws.send('uptime.list', {});
                if (alive) setServices(res.services);
            } catch (e) {
                if (alive) setServices([]);
                if (!(e instanceof WsError && e.code === 'forbidden')) {
                    setError(humanizeError(e, 'Impossible de charger les services surveillés.'));
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [canReadUptime]);

    const unlink = async (serviceId: number) => {
        setBusy(true);
        try {
            const res = await ws.send('project.uptimeUnlink', { projectId, serviceId });
            setServiceIds(res.serviceIds);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const byId = new Map((services ?? []).map((s) => [s.id, s]));

    return (
        <section className={styles.uptimeLinks}>
            <h3 className={styles.sectionTitle}>Services surveillés</h3>

            {error && <p className={styles.error}>{error}</p>}

            {serviceIds.map((id) => {
                const service = byId.get(id);
                // Sans le droit `uptime: read`, le serveur ne rend qu'un
                // identifiant nu : le bloc reste là, mais sans nom ni barres —
                // plutôt que de le faire disparaître.
                if (!service) {
                    return (
                        <section key={id} className={deployStyles.block}>
                            <header className={deployStyles.blockHead}>
                                <div className={deployStyles.blockIdent}>
                                    <p className={deployStyles.blockName}>Service #{id}</p>
                                </div>
                                {canWrite && (
                                    <div className={deployStyles.actions}>
                                        <Button
                                            variant='ghost'
                                            icon='x'
                                            onClick={() => void unlink(id)}
                                            disabled={busy}
                                        >
                                            Délier
                                        </Button>
                                    </div>
                                )}
                            </header>
                        </section>
                    );
                }
                return (
                    <UptimeLinkRow
                        key={id}
                        service={service}
                        canWrite={canWrite}
                        busy={busy}
                        onUnlink={() => void unlink(id)}
                    />
                );
            })}

            {serviceIds.length === 0 && (
                <p className={styles.empty}>
                    Aucun service rattaché. Reliez ce qui surveille l’application déployée, pour lire sa disponibilité
                    ici même.
                </p>
            )}

            {canWrite && canWriteUptime && (
                <div className={styles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter un uptime
                    </Button>
                </div>
            )}

            {canWrite && !canWriteUptime && (
                <span className={styles.hint}>
                    {canReadUptime
                        ? 'Votre rôle ne permet pas de modifier les uptimes de cet espace.'
                        : 'Votre rôle ne donne pas accès à Uptime dans cet espace.'}
                </span>
            )}

            <LinkUptimeDialog
                open={linkOpen}
                projectId={projectId}
                linkedIds={serviceIds}
                onClose={() => setLinkOpen(false)}
                onSaved={() => {
                    setLinkOpen(false);
                    void load();
                }}
            />
        </section>
    );
}

export default UptimeLinks;
