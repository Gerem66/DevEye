import { useState } from 'react';
import { Button, invalidate, openFeature, useResource, useWorkspaceMembers } from 'deveye-sdk-client';
import type { DeployClientProvider } from '@deveye/types/sdk/client';

import { api } from './api';
import { hostOf } from './format';
import { TargetDialog } from './TargetDialog';
import { TargetView } from './TargetView';
import styles from './style.module.css';

/**
 * Ce que le module offre aux écrans de l'app (`DEPLOY_CLIENT_PROVIDER`) :
 * l'onglet « Déploiement » d'un projet compose la liste des cibles de
 * l'espace, une cible reliée montrée en entier, et le dialogue de
 * déclaration, sans importer le module.
 *
 * `LinkedTarget` est autonome, et c'est la différence avec l'ancien bloc que
 * Projets écrivait lui-même : l'hôte ne lui tend qu'un identifiant (et le
 * projet d'où part le geste), et le bloc charge sa cible, suit les
 * invalidations de la feature et porte son propre dialogue de réglage.
 * L'hôte ne connaît ni la forme d'une cible, ni ses commandes.
 */

interface LinkedTargetProps {
    targetId: number;
    /** C'est bien de **ce** projet que part le geste : le déclenchement s'inscrira dans sa frise. */
    projectId: number;
    canWrite: boolean;
    onUnlink: () => void;
}

/** Une cible du projet : son identité, son dernier déploiement, ses actions. */
function LinkedTarget({ targetId, projectId, canWrite, onUnlink }: LinkedTargetProps) {
    const members = useWorkspaceMembers();
    const { data, error } = useResource(
        'deploy.detail',
        () => api.send('deploy.get', { targetId }),
        'Impossible de charger cette cible.',
        [targetId]
    );
    const [editing, setEditing] = useState(false);

    if (!data) return <p className={error ? styles.error : styles.hint}>{error ?? 'Chargement…'}</p>;
    const { target, deployments } = data;

    return (
        <>
            <TargetView
                target={target}
                deployments={deployments}
                members={members}
                canWrite={canWrite}
                projectId={projectId}
                onEdit={canWrite ? () => setEditing(true) : undefined}
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
                            c'est une navigation. `openFeature` écrit le
                            chemin `view:deploy l1:<id>` ; le module ne
                            l'écrit jamais lui-même. */}
                        <Button
                            variant='secondary'
                            icon='chevrons-right'
                            onClick={() => openFeature('deploy', target.id)}
                        >
                            Ouvrir le Déploiement
                        </Button>
                        {/* La confirmation et le déliement sont à l'hôte, qui
                            seul tient le pointeur. */}
                        {canWrite && (
                            <Button variant='ghost' onClick={onUnlink}>
                                Délier
                            </Button>
                        )}
                    </>
                }
            />

            {/* Le vrai dialogue de la feature, pas une copie : régler une cible
                depuis un projet ou depuis sa feature doit être le même geste. */}
            <TargetDialog
                open={editing}
                target={target}
                onClose={() => setEditing(false)}
                onSaved={() => {
                    setEditing(false);
                    invalidate('projects.board', 'deploy.list', 'deploy.detail');
                }}
            />
        </>
    );
}

interface LinkedTargetDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (targetId: number) => void;
}

/**
 * Le dialogue de la feature, en mode déclaration seulement : c'est le seul cas
 * de Projets, qui relie ce qui vient d'être déclaré. La modification passe par
 * `LinkedTarget`, qui tient la cible chargée.
 */
function LinkedTargetDialog({ open, onClose, onSaved }: LinkedTargetDialogProps) {
    return <TargetDialog open={open} target={null} onClose={onClose} onSaved={(target) => onSaved(target.id)} />;
}

export const clientProvider: DeployClientProvider = {
    listTargets: async () =>
        (await api.send('deploy.list', {})).targets.map((t) => ({
            id: t.id,
            name: t.name,
            host: hostOf(t.baseUrl)
        })),
    LinkedTarget,
    TargetDialog: LinkedTargetDialog
};
