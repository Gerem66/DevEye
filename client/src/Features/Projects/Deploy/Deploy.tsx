import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@deveye/types';
import { DEPLOY_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { DeployClientProvider, DeployLinkedCandidate } from '@deveye/types/sdk/client';
import { Button, Dialog } from '@/Components';
import { ws, WsError } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { moduleClientProvider } from '@/sdk/registry';
import { humanizeError } from '../api';
import { LinkTargetDialog } from './LinkTargetDialog';
import { UptimeLinks } from './UptimeLinks';
import styles from '../style.module.css';

interface DeployProps {
    project: Project;
    canWrite: boolean;
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
 * / `deployLink` / `deployUnlink`) et délègue tout l'affichage au module
 * Déploiement, par son contrat client (`DEPLOY_CLIENT_PROVIDER`) : cet écran
 * n'importe pas le module. C'est le bloc du module (`LinkedTarget`) qui charge
 * sa cible lui-même, suit les invalidations de la feature et porte son
 * dialogue de réglage.
 *
 * Corollaire à connaître : déclencher relève du droit `deploy`, pas de
 * `projects`. Un membre qui a l'un sans l'autre voit qu'il y a des cibles
 * rattachées sans pouvoir les ouvrir, et l'écran le dit. Module absent : même
 * lecture, des identifiants nus, et une phrase qui le dit.
 */
export function Deploy({ project, canWrite }: DeployProps) {
    const permissions = useWorkspacePermissions();
    const provider = moduleClientProvider<DeployClientProvider>(DEPLOY_CLIENT_PROVIDER);
    const canReadDeploy = permissions.canFeature('deploy');
    const canWriteDeploy = permissions.canFeature('deploy', 'write');

    const [targetIds, setTargetIds] = useState<number[]>([]);
    /** Les cibles de l'espace, pour nommer celle qu'on délie. */
    const [candidates, setCandidates] = useState<readonly DeployLinkedCandidate[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    /** La cible qu'on s'apprête à délier ; `null` = aucune confirmation ouverte. */
    const [unlinking, setUnlinking] = useState<number | null>(null);

    const boardVersion = useResourceVersion('project.board');
    const listVersion = useResourceVersion('deploy.list');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const res = await ws.send('project.deployList', { projectId: project.id });
            setTargetIds(res.targetIds);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les cibles reliées.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded]);

    useEffect(() => {
        void load();
    }, [load, boardVersion]);

    // Le catalogue, pour nommer la cible qu'on délie. Le détail relève de la
    // feature Déploiement : sans le droit (ou sans le module), on s'arrête aux
    // pointeurs plutôt que d'encaisser un refus, qui n'est pas une erreur à
    // afficher.
    useEffect(() => {
        if (guarded || !canReadDeploy || !provider) {
            setCandidates([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const listed = await provider.listTargets();
                if (alive) setCandidates(listed);
            } catch (e) {
                if (alive) setCandidates([]);
                if (!(e instanceof WsError && e.code === 'forbidden')) {
                    setError(humanizeError(e, 'Impossible de charger les cibles de l’espace.'));
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [guarded, canReadDeploy, provider, listVersion]);

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

    const unlinkingName = unlinking === null ? null : (candidates.find((c) => c.id === unlinking)?.name ?? null);

    return (
        <div className={styles.linkedTargets}>
            {error && <p className={styles.error}>{error}</p>}

            {/* Au-dessus des cibles, et non en dessous : « est-ce en ligne ? » se
                lit avant « qu'ai-je livré ? ». Rendu même sur un projet
                confidentiel — c'est la seule moitié de cet onglet qui ne dépende
                d'aucun service extérieur, et la faire disparaître emprisonnerait
                les services déjà rattachés. */}
            <UptimeLinks projectId={project.id} canWrite={canWrite} />

            <section className={styles.deployLinks}>
                <h3 className={styles.sectionTitle}>Déploiements</h3>

                {!provider && <p className={styles.hint}>Le module Déploiements n’est pas installé.</p>}

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

                {canReadDeploy &&
                    targetIds.map((id) =>
                        provider ? (
                            <provider.LinkedTarget
                                key={id}
                                targetId={id}
                                // C'est bien de **ce** projet que part le geste : le
                                // déclenchement s'inscrira dans sa frise.
                                projectId={project.id}
                                canWrite={canWrite && canWriteDeploy}
                                onUnlink={() => setUnlinking(id)}
                            />
                        ) : (
                            // Sans le module, le serveur ne rend qu'un identifiant
                            // nu : la ligne reste là, avec son « Délier », plutôt
                            // que de disparaître.
                            <div key={id} className={styles.linkedBare}>
                                <span className={styles.hint}>Cible #{id}</span>
                                {canWrite && canWriteDeploy && (
                                    <Button variant='ghost' icon='x' onClick={() => setUnlinking(id)} disabled={busy}>
                                        Délier
                                    </Button>
                                )}
                            </div>
                        )
                    )}

                {/* Toujours en bas, même quand une cible est déjà reliée : un
                    projet en déploie parfois deux (une application et sa
                    base). */}
                {!guarded && canWrite && canWriteDeploy && provider && (
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

            <Dialog
                open={unlinking !== null}
                onClose={() => setUnlinking(null)}
                title='Délier cette cible ?'
                width={460}
                onSubmit={() => unlinking !== null && void unlink(unlinking)}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setUnlinking(null)} disabled={busy}>
                            Annuler
                        </Button>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() => unlinking !== null && void unlink(unlinking)}
                        >
                            Délier
                        </Button>
                    </>
                }
            >
                <p className={styles.hint}>
                    <strong>{unlinkingName ?? 'Cette cible'}</strong> quitte ce projet : plus rien ne sera déclenché
                    d’ici. La cible, son historique et les autres projets qui la déploient ne sont pas touchés.
                </p>
            </Dialog>
        </div>
    );
}

export default Deploy;
