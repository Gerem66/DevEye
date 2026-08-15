import { useCallback, useEffect, useState } from 'react';
import type { DeployTarget, Deployment, MinimalUser, Project } from 'deveye-types';
import { Button, Dialog } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { startTeleport } from '@/stores/live';
import { getActiveWorkspaceId, useWorkspacePermissions } from '@/stores/workspace';
import { TargetDialog } from '@/Features/Deploy/TargetDialog';
import { TargetView } from '@/Features/Deploy/TargetView';
import deployStyles from '@/Features/Deploy/style.module.css';
import { humanizeError } from '../api';
import { LinkTargetDialog } from './LinkTargetDialog';
import { UptimeLinks } from './UptimeLinks';
import styles from '../style.module.css';

interface DeployProps {
    project: Project;
    members: MinimalUser[];
    canWrite: boolean;
}

/** Ce qu'une cible ouverte dans cet onglet porte avec elle. */
interface Linked {
    target: DeployTarget;
    deployments: Deployment[];
}

/**
 * L'onglet Déploiement d'un projet : les cibles qu'il met en production.
 *
 * Enveloppe mince, exactement comme les onglets Git, Bases et Audience — et
 * c'est nouveau : le déploiement fut le dernier module à vivre **dans** le
 * projet. **La cible n'appartient pas au projet** : elle vit dans sa feature,
 * avec sa clé, son historique et son suivi d'état, et plusieurs projets peuvent
 * déployer la même — le cas normal quand un client et un serveur partent dans la
 * même pile compose. Cet onglet ne possède qu'un pointeur (`project.deployList`
 * / `deployLink` / `deployUnlink`) et délègue tout l'affichage à `TargetView`.
 *
 * Corollaire à connaître : déclencher relève du droit `deploy`, pas de
 * `projects`. Un membre qui a l'un sans l'autre voit qu'il y a des cibles
 * rattachées sans pouvoir les ouvrir, et l'écran le dit.
 */
export function Deploy({ project, members, canWrite }: DeployProps) {
    const permissions = useWorkspacePermissions();
    const canReadDeploy = permissions.canFeature('deploy');
    const canWriteDeploy = permissions.canFeature('deploy', 'write');

    const [targetIds, setTargetIds] = useState<number[]>([]);
    const [linked, setLinked] = useState<Linked[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    const [editing, setEditing] = useState<DeployTarget | null>(null);
    const [unlinking, setUnlinking] = useState<DeployTarget | null>(null);

    const boardVersion = useResourceVersion('project.board');
    const deployVersion = useResourceVersion('deploy.detail');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const res = await ws.send('project.deployList', { projectId: project.id });
            setTargetIds(res.targetIds);
            // Le détail relève de la feature Déploiement : sans le droit, on
            // s'arrête aux pointeurs plutôt que d'encaisser un refus.
            setLinked(
                canReadDeploy
                    ? (await Promise.all(res.targetIds.map((targetId) => ws.send('deploy.get', { targetId })))).map(
                          (r) => ({ target: r.target, deployments: r.deployments })
                      )
                    : []
            );
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les cibles reliées.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded, canReadDeploy]);

    useEffect(() => {
        void load();
    }, [load, boardVersion, deployVersion]);

    const unlink = async (targetId: number) => {
        setBusy(true);
        try {
            await ws.send('project.deployUnlink', { projectId: project.id, targetId });
            setUnlinking(null);
            invalidate('project.board', 'deploy.list');
        } catch (e) {
            setError(humanizeError(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    return (
        <div className={deployStyles.feature}>
            {error && <p className={styles.error}>{error}</p>}

            {/* Au-dessus des cibles, et non en dessous : « est-ce en ligne ? » se
                lit avant « qu'ai-je livré ? ». Rendu même sur un projet
                confidentiel — c'est la seule moitié de cet onglet qui ne dépende
                d'aucun service extérieur, et la faire disparaître emprisonnerait
                les services déjà rattachés. */}
            <UptimeLinks projectId={project.id} canWrite={canWrite} />

            <section className={styles.deployLinks}>
                <h3 className={styles.sectionTitle}>Déploiements</h3>

                {guarded && (
                    <p className={styles.empty}>
                        Ce projet est confidentiel : il ne peut pas être relié à un déploiement, car le suivi tourne
                        sans session et n’a pas accès à sa clé.
                    </p>
                )}

                {!guarded && targetIds.length === 0 && <p className={styles.empty}>Aucune cible reliée à ce projet.</p>}

                {targetIds.length > 0 && !canReadDeploy && (
                    <p className={styles.empty}>
                        Ce projet déploie {targetIds.length} cible{targetIds.length > 1 ? 's' : ''}, mais votre rôle
                        n’ouvre pas la feature « Déploiement ».
                    </p>
                )}

                {linked.map((item) => (
                    <TargetView
                        key={item.target.id}
                        target={item.target}
                        deployments={item.deployments}
                        members={members}
                        canWrite={canWrite && canWriteDeploy}
                        // C'est bien de **ce** projet que part le geste : le
                        // déclenchement s'inscrira dans sa frise.
                        projectId={project.id}
                        onEdit={canWriteDeploy ? () => setEditing(item.target) : undefined}
                        // L'historique complet est un panneau de la feature Déploiement,
                        // pas de cet onglet : ici, le dernier déploiement affiché dans
                        // l'en-tête suffit, comme avant que l'historique n'ait sa propre carte.
                        showHistory={false}
                        after={
                            <>
                                {/* Le sens qui manquerait sinon : la feature sait
                                    mener aux projets d'une cible, l'onglet d'un
                                    projet doit savoir mener à la cible. Par la
                                    téléportation, comme partout — garde d'accès
                                    comprise. Offert même sans droit d'écriture,
                                    c'est une navigation. */}
                                <Button
                                    variant='secondary'
                                    icon='chevrons-right'
                                    onClick={() =>
                                        startTeleport(getActiveWorkspaceId() ?? 0, [
                                            'view:deploy',
                                            `l1:target:${item.target.id}`
                                        ])
                                    }
                                >
                                    Ouvrir le Déploiement
                                </Button>
                                {canWrite && canWriteDeploy && (
                                    <Button variant='ghost' onClick={() => setUnlinking(item.target)} disabled={busy}>
                                        Délier
                                    </Button>
                                )}
                            </>
                        }
                    />
                ))}

                {/* Toujours en bas, même quand une cible est déjà reliée : un
                    projet en déploie parfois deux (une application et sa
                    base). */}
                {!guarded && canWrite && canWriteDeploy && (
                    <div className={styles.addRow}>
                        <Button icon='add' onClick={() => setLinkOpen(true)}>
                            Ajouter une cible
                        </Button>
                    </div>
                )}

                {!guarded && canWrite && !canWriteDeploy && (
                    <span className={styles.hint}>
                        Votre rôle ne permet pas de modifier les déploiements de cet espace.
                    </span>
                )}
            </section>

            <LinkTargetDialog
                open={linkOpen}
                projectId={project.id}
                linkedIds={targetIds}
                onClose={() => setLinkOpen(false)}
                onSaved={() => {
                    setLinkOpen(false);
                    invalidate('project.board', 'deploy.list', 'deploy.count');
                }}
            />

            {/* Le vrai dialogue de la feature, pas une copie : régler une cible
                depuis un projet ou depuis sa feature doit être le même geste. */}
            <TargetDialog
                open={editing !== null}
                target={editing}
                onClose={() => setEditing(null)}
                onSaved={() => {
                    setEditing(null);
                    invalidate('project.board', 'deploy.list', 'deploy.detail');
                }}
            />

            <Dialog
                open={unlinking !== null}
                onClose={() => setUnlinking(null)}
                title='Délier cette cible ?'
                width={460}
                onSubmit={() => unlinking && void unlink(unlinking.id)}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setUnlinking(null)} disabled={busy}>
                            Annuler
                        </Button>
                        <Button variant='danger' disabled={busy} onClick={() => unlinking && void unlink(unlinking.id)}>
                            Délier
                        </Button>
                    </>
                }
            >
                <p className={styles.hint}>
                    {unlinking && (
                        <>
                            <strong>{unlinking.name}</strong> quitte ce projet : plus rien ne sera déclenché d’ici. La
                            cible, son historique et les autres projets qui la déploient ne sont pas touchés.
                        </>
                    )}
                </p>
            </Dialog>
        </div>
    );
}

export default Deploy;
