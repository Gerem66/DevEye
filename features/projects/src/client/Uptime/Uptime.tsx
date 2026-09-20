import { useCallback, useEffect, useState } from 'react';
import { UPTIME_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { UptimeClientProvider, UptimeLinkedService } from '@deveye/types/sdk/client';
import { Button, humanizeError, moduleClientProvider, useWorkspacePermissions, WsError } from 'deveye-sdk-client';
import { api } from '../api';
import type { Project, ProjectLinkLabel } from '../../contracts/domain';
import { LinkUptimeDialog } from './LinkUptimeDialog';
import { UptimeLinkRow } from './UptimeLinkRow';
import { ForeignLinks } from '../ForeignLinks';
import styles from '../style.module.css';

interface UptimeProps {
    project: Project;
    canWrite: boolean;
}

/**
 * L'onglet Uptime d'un projet : les services surveillés qu'il rattache. Le
 * service n'appartient pas au projet, qui n'en tient qu'un pointeur, et deux
 * projets surveillant la même adresse sont le cas normal.
 *
 * Le serveur ne rend que des identifiants ; les noms et les états viennent de
 * la liste du module Uptime, lue au nom de l'utilisateur. Sans accès à Uptime,
 * ou sans le module, les services se listent en identifiants nus.
 */
export function Uptime({ project, canWrite }: UptimeProps) {
    const projectId = project.id;
    const foreign = project.foreign;
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
            <div className={styles.uptimeLinks}>
                {error && <p className={styles.error}>{error}</p>}
                {!uptime && <p className={styles.hint}>Le module Uptime n’est pas installé.</p>}
                <ForeignLinks labels={labels} empty='Aucun service rattaché à ce projet.' />
            </div>
        );
    }

    const byId = new Map((services ?? []).map((s) => [s.id, s]));

    return (
        <div className={styles.uptimeLinks}>
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
                    Aucun service rattaché. Reliez ce qui surveille ce projet, pour lire sa disponibilité ici même.
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
        </div>
    );
}

export default Uptime;
