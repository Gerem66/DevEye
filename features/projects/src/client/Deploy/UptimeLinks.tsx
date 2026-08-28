import { useCallback, useEffect, useState } from 'react';
import { UPTIME_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { UptimeClientProvider, UptimeLinkedService } from '@deveye/types/sdk/client';
import { Button, humanizeError, moduleClientProvider, useWorkspacePermissions, WsError } from 'deveye-sdk-client';
import { api } from '../api';
import type { ProjectLinkLabel } from '../../contracts/domain';
import { LinkUptimeDialog } from './LinkUptimeDialog';
import { UptimeLinkRow } from './UptimeLinkRow';
import { ForeignLinks } from '../ForeignLinks';
import styles from '../style.module.css';

interface UptimeLinksProps {
    projectId: number;
    canWrite: boolean;
    /**
     * Le projet est projeté depuis un autre espace : les services se nomment,
     * sans bloc ni geste (voir `ForeignLinks`). Rattacher et délier sont des
     * gestes du domicile, que le serveur refuse depuis une fenêtre.
     */
    foreign?: boolean;
}

/**
 * Les services surveillés que ce projet rattache.
 *
 * Ils vivent dans l'onglet Déploiement, et nulle part ailleurs : c'est
 * l'endroit où l'on se demande si ce qui vient d'être livré tient debout, donc
 * l'endroit où « est-ce en ligne ? » est la question suivante. Un panneau
 * générique posé sur tous les onglets, comme l'ancien « Liens DevEye »,
 * répondait à cette question partout, c'est-à-dire nulle part.
 *
 * **Chaque feature garde ses droits.** Le serveur ne rend que des identifiants ;
 * les noms et les états viennent de la liste du module Uptime, lue par son
 * contrat client (`listServices`, au nom de l'utilisateur). Un membre sans
 * accès à Uptime voit donc qu'il y a des services rattachés, sans pouvoir les
 * nommer, plutôt que de les voir disparaître. Module absent : même lecture,
 * des identifiants nus, et une phrase qui le dit.
 */
export function UptimeLinks({ projectId, canWrite, foreign = false }: UptimeLinksProps) {
    const permissions = useWorkspacePermissions();
    const uptime = moduleClientProvider<UptimeClientProvider>(UPTIME_CLIENT_PROVIDER);
    const canReadUptime = permissions.canFeature('uptime');
    const canWriteUptime = permissions.canFeature('uptime', 'write');
    const [serviceIds, setServiceIds] = useState<number[]>([]);
    /** Les services nommés par le serveur : ce qu'un projet projeté en montre. */
    const [labels, setLabels] = useState<readonly ProjectLinkLabel[]>([]);
    const [services, setServices] = useState<readonly UptimeLinkedService[] | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await api.send('projects.uptimeList', { projectId });
            setServiceIds(res.serviceIds);
            setLabels(res.labels);
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
        if (foreign || !canReadUptime || !uptime) {
            setServices([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const listed = await uptime.listServices();
                if (alive) setServices(listed);
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
    }, [foreign, canReadUptime, uptime]);

    const unlink = async (serviceId: number) => {
        setBusy(true);
        try {
            const res = await api.send('projects.uptimeUnlink', { projectId, serviceId });
            setServiceIds(res.serviceIds);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (foreign) {
        return (
            <section className={styles.uptimeLinks}>
                <h3 className={styles.sectionTitle}>Services surveillés</h3>
                {error && <p className={styles.error}>{error}</p>}
                {!uptime && <p className={styles.hint}>Le module Uptime n’est pas installé.</p>}
                {/* Sans le rappel du domicile : l'onglet le dit une fois, sous
                    les déploiements. */}
                <ForeignLinks labels={labels} empty='Aucun service rattaché à ce projet.' note={false} />
            </section>
        );
    }

    const byId = new Map((services ?? []).map((s) => [s.id, s]));

    return (
        <section className={styles.uptimeLinks}>
            <h3 className={styles.sectionTitle}>Services surveillés</h3>

            {error && <p className={styles.error}>{error}</p>}
            {!uptime && <p className={styles.hint}>Le module Uptime n’est pas installé.</p>}

            {serviceIds.map((id) => {
                const service = byId.get(id);
                // Sans le droit `uptime: read` (ou sans le module), le serveur
                // ne rend qu'un identifiant nu : le bloc reste là, mais sans
                // nom ni barres, plutôt que de le faire disparaître.
                if (!service) {
                    return (
                        <section key={id} className={styles.block}>
                            <header className={styles.blockHead}>
                                <div className={styles.blockIdent}>
                                    <p className={styles.blockName}>Service #{id}</p>
                                </div>
                                {canWrite && (
                                    <div className={styles.actions}>
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

            {canWrite && canWriteUptime && uptime && (
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
