import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@deveye/types';
import { AUDIENCE_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { AudienceClientProvider, AudienceLinkedCandidate } from '@deveye/types/sdk/client';
import { Button, Dialog } from '@/Components';
import { ws, WsError } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { moduleClientProvider } from '@/sdk/registry';
import { humanizeError } from '../api';
import { LinkSiteDialog } from './LinkSiteDialog';
import styles from '../style.module.css';

interface AudienceProps {
    project: Project;
    canWrite: boolean;
}

/**
 * L'onglet « Audience » d'un projet : les sites qu'il suit.
 *
 * Enveloppe mince, exactement comme les onglets Git et Bases de données. **Le
 * site n'appartient pas au projet** : il vit dans sa feature, avec ses réglages
 * et sa clé, et plusieurs projets peuvent suivre le même. Cet onglet ne possède
 * qu'un pointeur (`project.audienceList` / `audienceLink` / `audienceUnlink`) et
 * délègue tout l'affichage au module Audience, par son contrat client
 * (`AUDIENCE_CLIENT_PROVIDER`) : cet écran n'importe pas le module.
 *
 * Le contenu est rendu **ici**, et non derrière un renvoi vers la feature : les
 * chiffres d'un projet se consultent depuis le projet, sinon la liaison ne sert
 * qu'à ranger. C'est le bloc du module (`LinkedSite`), qui charge son site
 * lui-même, suit les invalidations de la feature et porte sa barre collante.
 *
 * Corollaire à connaître : lire une audience relève du droit `audience`, pas de
 * `projects`. Un membre qui a l'un sans l'autre voit qu'il y a des sites
 * rattachés sans pouvoir les ouvrir, et l'écran le dit. Module absent : même
 * lecture, des identifiants nus, et une phrase qui le dit.
 */
export function Audience({ project, canWrite }: AudienceProps) {
    const permissions = useWorkspacePermissions();
    const provider = moduleClientProvider<AudienceClientProvider>(AUDIENCE_CLIENT_PROVIDER);
    const canReadAudience = permissions.canFeature('audience');
    const canWriteAudience = permissions.canFeature('audience', 'write');

    const [linkedIds, setLinkedIds] = useState<number[]>([]);
    /** Les sites de l'espace, pour nommer celui qu'on délie. */
    const [candidates, setCandidates] = useState<readonly AudienceLinkedCandidate[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    /** Le site qu'on s'apprête à délier ; `null` = aucune confirmation ouverte. */
    const [unlinking, setUnlinking] = useState<number | null>(null);

    const boardVersion = useResourceVersion('project.board');
    const listVersion = useResourceVersion('audience.list');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const res = await ws.send('project.audienceList', { projectId: project.id });
            setLinkedIds(res.siteIds);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les sites liés.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded]);

    useEffect(() => {
        void load();
    }, [load, boardVersion]);

    // Le catalogue, pour nommer le site qu'on délie. Le détail relève de la
    // feature Audience : sans le droit (ou sans le module), on s'arrête aux
    // pointeurs plutôt que d'encaisser un refus, qui n'est pas une erreur à
    // afficher.
    useEffect(() => {
        if (guarded || !canReadAudience || !provider) {
            setCandidates([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const listed = await provider.listSites();
                if (alive) setCandidates(listed);
            } catch (e) {
                if (alive) setCandidates([]);
                if (!(e instanceof WsError && e.code === 'forbidden')) {
                    setError(humanizeError(e, 'Impossible de charger les sites de l’espace.'));
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [guarded, canReadAudience, provider, listVersion]);

    const unlink = async (siteId: number) => {
        setBusy(true);
        try {
            await ws.send('project.audienceUnlink', { projectId: project.id, siteId });
            setUnlinking(null);
            invalidate('project.board', 'audience.list');
        } catch (e) {
            setError(humanizeError(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (guarded) {
        return (
            <p className={styles.empty}>
                Ce projet est confidentiel : il ne peut pas être relié à un site suivi. Les sites vivent sous la clé de
                l’espace, et leur ingestion tourne sans session.
            </p>
        );
    }

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    const unlinkingName = unlinking === null ? null : (candidates.find((c) => c.id === unlinking)?.name ?? null);

    return (
        <div className={styles.linkedSites}>
            {error && <p className={styles.error}>{error}</p>}
            {!provider && <p className={styles.hint}>Le module Audience n’est pas installé.</p>}

            {linkedIds.length === 0 && <p className={styles.empty}>Aucun site suivi relié à ce projet.</p>}

            {linkedIds.length > 0 && !canReadAudience && (
                <p className={styles.empty}>
                    Ce projet suit {linkedIds.length} site{linkedIds.length > 1 ? 's' : ''}, mais votre rôle n’ouvre pas
                    la feature « Audience ».
                </p>
            )}

            {canReadAudience &&
                linkedIds.map((id) =>
                    provider ? (
                        <provider.LinkedSite
                            key={id}
                            siteId={id}
                            canWrite={canWrite && canWriteAudience}
                            onUnlink={() => setUnlinking(id)}
                        />
                    ) : (
                        // Sans le module, le serveur ne rend qu'un identifiant
                        // nu : la ligne reste là, avec son « Délier », plutôt
                        // que de disparaître.
                        <div key={id} className={styles.linkedBare}>
                            <span className={styles.hint}>Site #{id}</span>
                            {canWrite && canWriteAudience && (
                                <Button variant='ghost' icon='x' onClick={() => setUnlinking(id)} disabled={busy}>
                                    Délier
                                </Button>
                            )}
                        </div>
                    )
                )}

            {/* Toujours en bas, même quand un site est déjà relié : on peut en
                ajouter autant qu'on veut. */}
            {canWrite && canWriteAudience && provider && (
                <div className={styles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter un site
                    </Button>
                </div>
            )}

            {canWrite && !canWriteAudience && (
                <span className={styles.hintCentered}>
                    Votre rôle ne permet pas de modifier les sites suivis de cet espace.
                </span>
            )}

            <LinkSiteDialog
                open={linkOpen}
                projectId={project.id}
                linkedIds={linkedIds}
                onClose={() => setLinkOpen(false)}
                onSaved={() => {
                    setLinkOpen(false);
                    invalidate('project.board', 'audience.list', 'audience.count');
                }}
            />

            <Dialog
                open={unlinking !== null}
                onClose={() => setUnlinking(null)}
                title='Délier ce site ?'
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
                    <strong>{unlinkingName ?? 'Ce site'}</strong> quitte ce projet. Le site, son historique et les
                    autres projets qui le suivent ne sont pas touchés.
                </p>
            </Dialog>
        </div>
    );
}

export default Audience;
