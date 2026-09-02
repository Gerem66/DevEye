import { Button, openFeature, useResource, useWorkspaceMembers } from 'deveye-sdk-client';
import type { DeployClientProvider } from '@deveye/types/sdk/client';

import { api } from './api';
import { hostOf } from './format';
import { TargetDialog } from './TargetDialog';
import { TargetView } from './TargetView';
import styles from './style.module.css';

/**
 * Ce que le module offre aux écrans de l'app (`DEPLOY_CLIENT_PROVIDER`) :
 * l'onglet « Déploiement » d'un projet compose la liste des cibles, une cible
 * reliée en entier et le dialogue de déclaration. `LinkedTarget` est autonome :
 * l'hôte ne tend qu'un identifiant et le projet d'où part le geste.
 */

interface LinkedTargetProps {
    targetId: number;
    /** C'est bien de **ce** projet que part le geste : le déclenchement s'inscrira dans sa frise. */
    projectId: number;
    canWrite: boolean;
    onUnlink: () => void;
}

/**
 * Une cible du projet : son identité, son dernier déploiement, ses actions.
 * Ses réglages (accès, identifiant, suppression) passent par le bouton commun
 * de `TargetView`, les mêmes que sur sa fiche.
 */
function LinkedTarget({ targetId, projectId, canWrite, onUnlink }: LinkedTargetProps) {
    const members = useWorkspaceMembers();
    const { data, error } = useResource(
        'deploy.detail',
        () => api.send('deploy.get', { targetId }),
        'Impossible de charger cette cible.',
        [targetId]
    );

    if (!data) return <p className={error ? styles.error : styles.hint}>{error ?? 'Chargement…'}</p>;
    const { target, deployments } = data;

    return (
        <TargetView
            target={target}
            deployments={deployments}
            members={members}
            canWrite={canWrite}
            projectId={projectId}
            // L'historique complet est un panneau de la feature, pas de cet
            // onglet : le dernier déploiement de l'en-tête suffit.
            showHistory={false}
            after={
                <>
                    {/* L'onglet d'un projet doit mener à la cible, par la
                        téléportation (garde d'accès comprise) : `openFeature`
                        écrit le chemin, jamais le module. */}
                    <Button variant='secondary' icon='chevrons-right' onClick={() => openFeature('deploy', target.id)}>
                        Ouvrir le Déploiement
                    </Button>
                    {/* Le déliement est à l'hôte, qui seul tient le pointeur. */}
                    {canWrite && (
                        <Button variant='ghost' onClick={onUnlink}>
                            Délier
                        </Button>
                    )}
                </>
            }
        />
    );
}

interface LinkedTargetDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (targetId: number) => void;
}

/**
 * Le dialogue de déclaration de la feature, pas une copie : Projets relie ce
 * qui vient d'être déclaré. Une cible reliée se règle par le bouton commun de
 * `LinkedTarget`.
 */
function LinkedTargetDialog({ open, onClose, onSaved }: LinkedTargetDialogProps) {
    return <TargetDialog open={open} onClose={onClose} onSaved={(target) => onSaved(target.id)} />;
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
