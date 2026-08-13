import { useCallback, useEffect, useState } from 'react';
import type { AudienceSite, Project } from 'deveye-types';

import { Button, Dialog } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { startTeleport } from '@/stores/live';
import { getActiveWorkspaceId, useWorkspacePermissions } from '@/stores/workspace';
import { SiteView } from '@/Features/Audience/SiteView';
import audienceStyles from '@/Features/Audience/style.module.css';
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
 * délègue tout l'affichage à `SiteView`, le composant de la feature.
 *
 * Le contenu est rendu **ici**, et non derrière un renvoi vers la feature : les
 * chiffres d'un projet se consultent depuis le projet, sinon la liaison ne sert
 * qu'à ranger.
 *
 * Corollaire à connaître : lire une audience relève du droit `audience`, pas de
 * `projects`. Un membre qui a l'un sans l'autre voit qu'il y a des sites
 * rattachés sans pouvoir les ouvrir, et l'écran le dit.
 */
export function Audience({ project, canWrite }: AudienceProps) {
    const permissions = useWorkspacePermissions();
    const canReadAudience = permissions.canFeature('audience');
    const canWriteAudience = permissions.canFeature('audience', 'write');

    const [linkedIds, setLinkedIds] = useState<number[]>([]);
    const [linked, setLinked] = useState<AudienceSite[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    const [unlinking, setUnlinking] = useState<AudienceSite | null>(null);

    const boardVersion = useResourceVersion('project.board');
    const detailVersion = useResourceVersion('audience.detail');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const res = await ws.send('project.audienceList', { projectId: project.id });
            setLinkedIds(res.siteIds);
            // Le détail relève de la feature Audience : sans le droit, on
            // s'arrête aux pointeurs plutôt que d'encaisser un refus.
            setLinked(
                canReadAudience
                    ? (await Promise.all(res.siteIds.map((siteId) => ws.send('audience.get', { siteId })))).map(
                          (r) => r.site
                      )
                    : []
            );
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les sites liés.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded, canReadAudience]);

    useEffect(() => {
        void load();
    }, [load, boardVersion, detailVersion]);

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

    return (
        <div className={audienceStyles.detail}>
            {error && <p className={styles.error}>{error}</p>}

            {linkedIds.length === 0 && <p className={styles.empty}>Aucun site suivi relié à ce projet.</p>}

            {linkedIds.length > 0 && !canReadAudience && (
                <p className={styles.empty}>
                    Ce projet suit {linkedIds.length} site{linkedIds.length > 1 ? 's' : ''}, mais votre rôle n’ouvre pas
                    la feature « Audience ».
                </p>
            )}

            {linked.map((site) => (
                <section key={site.id} className={audienceStyles.panel}>
                    {/* L'intitulé et les actions sont passés à `SiteView`, qui
                        les loge dans sa barre de période déjà collante. Un
                        second bandeau collant au-dessus se serait empilé sous le
                        premier, ou aurait glissé dessous. */}
                    <SiteView
                        site={site}
                        canWrite={canWrite && canWriteAudience}
                        heading={<h3 className={audienceStyles.blockTitle}>{site.name}</h3>}
                        actions={
                            <div className={audienceStyles.detailActions}>
                                {/* Le sens qui manquerait sinon : la feature sait
                                    mener aux projets d'un site, l'onglet d'un
                                    projet doit savoir mener au site. Par la
                                    téléportation, comme partout : le chemin dit
                                    « ouvre la feature, et dedans, ce site-là »,
                                    garde d'accès comprise. Offert même sans droit
                                    d'écriture, c'est une navigation. */}
                                <Button
                                    variant='secondary'
                                    icon='expand'
                                    onClick={() =>
                                        startTeleport(getActiveWorkspaceId() ?? 0, [
                                            'view:audience',
                                            `l1:site:${site.id}`
                                        ])
                                    }
                                >
                                    Ouvrir dans Audience
                                </Button>
                                {canWrite && canWriteAudience && (
                                    <Button variant='ghost' onClick={() => setUnlinking(site)} disabled={busy}>
                                        Délier
                                    </Button>
                                )}
                            </div>
                        }
                    />
                </section>
            ))}

            {/* Toujours en bas, même quand un site est déjà relié : on peut en
                ajouter autant qu'on veut. */}
            {canWrite && canWriteAudience && (
                <div className={audienceStyles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter un site
                    </Button>
                </div>
            )}

            {canWrite && !canWriteAudience && (
                <span className={styles.hint}>
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
                            <strong>{unlinking.name}</strong> quitte ce projet. Le site, son historique et les autres
                            projets qui le suivent ne sont pas touchés.
                        </>
                    )}
                </p>
            </Dialog>
        </div>
    );
}

export default Audience;
