import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudienceSite, AudienceUsage } from '@deveye/types';

import { Button } from '@/Components';
import { FeatureSettingsButton } from '@/Components/FeatureSettings';
import { ws } from '@/api/ws';
import { useLiveOutlines } from '@/live/useLiveOutline';
import { useLiveSegment } from '@/live/useLiveSegment';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import type { FeatureProps } from '@/Features/types';
import { humanizeError } from '../Projects/api';
import SiteDetail from './SiteDetail';
import SiteDialog from './SiteDialog';
import SiteList from './SiteList';
import styles from './style.module.css';

/**
 * Audience — les sites suivis de l'espace actif.
 *
 * Feature de premier rang, et non un onglet des Projets : un site appartient à
 * l'espace, plusieurs projets peuvent le suivre, et certains ne servent aucun
 * projet. Un projet ne fait qu'y **pointer**. C'est la forme des features Git et
 * Bases de données, et pour les mêmes raisons.
 *
 * **Rien ici ne mesure quoi que ce soit.** Les visites entrent par une porte
 * publique que ce composant ne connaît pas (`/api/t/b`), et cet écran ne fait
 * que lire ce qu'elle a écrit. C'est aussi pourquoi il ne demande jamais de mot
 * de passe : tout vit à l'étage ouvert, sous la clé de l'espace.
 */
export function FeatureAudience({ workspace }: FeatureProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('audience', 'write');

    const [sites, setSites] = useState<AudienceSite[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    /** Le site ouvert ; `null` = on est sur la liste. */
    const [openedId, setOpenedId] = useState<number | null>(null);
    const [opened, setOpened] = useState<{
        site: AudienceSite;
        usage: AudienceUsage[];
        ingestOrigin: string;
    } | null>(null);

    const [dialog, setDialog] = useState<{ site: AudienceSite | null } | null>(null);

    const listVersion = useResourceVersion('audience.list');
    const detailVersion = useResourceVersion('audience.detail');

    /** Un glisser-déposer est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const pendingReload = useRef(false);

    // Présence : « qui regarde quel site ». Un seul déclarant par niveau — ce
    // composant possède `l1`, et rien d'autre dans la feature n'y touche.
    const l1Target = useLiveSegment('l1', openedId === null ? null : String(openedId));
    const outlineFor = useLiveOutlines('l1');

    /**
     * Suivre ce qu'une téléportation demande à ce niveau.
     *
     * La cible est rendue tant qu'elle n'est pas atteinte, jamais consommée : on
     * peut donc attendre que la liste soit chargée pour vérifier que le site
     * existe, et l'ignorer sans rien avoir à acquitter s'il a disparu.
     */
    useEffect(() => {
        if (!l1Target) return;
        if (l1Target.value === null) {
            setOpenedId(null);
            return;
        }
        const id = Number(l1Target.value.replace(/^site:/, ''));
        if (!Number.isInteger(id) || !sites?.some((s) => s.id === id)) return;
        setOpenedId(id);
    }, [l1Target, sites]);

    const reload = useCallback(async () => {
        try {
            const res = await ws.send('audience.list', {});
            setSites(res.sites);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les sites.'));
        }
    }, []);

    useEffect(() => {
        // Une relecture réordonne la liste sous le pointeur : jamais pendant un
        // glissé. Elle est retenue et rejouée au relâchement.
        if (dragging.current) {
            pendingReload.current = true;
            return;
        }
        void reload();
    }, [reload, workspace.id, listVersion]);

    const loadOpened = useCallback(async (siteId: number) => {
        try {
            const res = await ws.send('audience.get', { siteId });
            setOpened({ site: res.site, usage: res.usage, ingestOrigin: res.ingestOrigin });
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger ce site.'));
            setOpened(null);
        }
    }, []);

    useEffect(() => {
        if (openedId === null) {
            setOpened(null);
            return;
        }
        void loadOpened(openedId);
    }, [openedId, loadOpened, detailVersion]);

    const onDragStateChange = useCallback(
        (active: boolean) => {
            dragging.current = active;
            if (!active && pendingReload.current) {
                pendingReload.current = false;
                void reload();
            }
        },
        [reload]
    );

    const reorder = useCallback(
        (siteIds: number[]) => {
            // On range d'abord localement, pour que la carte reste là où on l'a
            // lâchée sans aller-retour, puis on persiste.
            setSites((prev) => {
                if (!prev) return prev;
                const byId = new Map(prev.map((s) => [s.id, s]));
                return siteIds.flatMap((id) => byId.get(id) ?? []);
            });
            ws.send('audience.reorder', { siteIds }).catch(() => {
                setError('Réorganisation impossible.');
                void reload();
            });
        },
        [reload]
    );

    return (
        <div className={styles.feature}>
            {openedId === null ? (
                <>
                    <header className={styles.head}>
                        <div>
                            <h2 className={styles.title}>Sites suivis</h2>
                            <p className={styles.subtitle}>Ce que les visiteurs font de vos projets une fois livrés.</p>
                        </div>
                        {/* Le bouton commun, monté sans condition comme partout :
                            il se supprime lui-même tant qu'aucune section
                            n'existe à cette échelle. */}
                        <FeatureSettingsButton scope={{ kind: 'feature', feature: 'audience' }} />
                        {canWrite && (
                            <Button icon='add' onClick={() => setDialog({ site: null })}>
                                Suivre un site
                            </Button>
                        )}
                    </header>

                    {error && <p className={styles.error}>{error}</p>}

                    {sites === null ? (
                        <p className={styles.empty}>Chargement…</p>
                    ) : sites.length === 0 ? (
                        <p className={styles.empty}>
                            Aucun site suivi.{' '}
                            {canWrite
                                ? 'Déclarez-en un, collez sa balise, et les chiffres arrivent.'
                                : 'Un membre disposant du droit d’écriture peut en déclarer un.'}
                        </p>
                    ) : (
                        <SiteList
                            sites={sites}
                            outlineFor={outlineFor}
                            canWrite={canWrite}
                            onOpen={setOpenedId}
                            onReorder={reorder}
                            onDragStateChange={onDragStateChange}
                        />
                    )}
                </>
            ) : opened === null ? (
                <p className={styles.empty}>{error ?? 'Chargement…'}</p>
            ) : (
                <SiteDetail
                    site={opened.site}
                    usage={opened.usage}
                    ingestOrigin={opened.ingestOrigin}
                    canWrite={canWrite}
                    onBack={() => setOpenedId(null)}
                    onEdit={() => setDialog({ site: opened.site })}
                    onSiteChanged={(site) => setOpened((prev) => (prev ? { ...prev, site } : prev))}
                />
            )}

            <SiteDialog
                open={dialog !== null}
                site={dialog?.site ?? null}
                onClose={() => setDialog(null)}
                onSaved={(site) => {
                    setDialog(null);
                    // La fiche ouverte doit refléter le réglage tout de suite ;
                    // la liste, elle, se relit par l'invalidation posée dans le
                    // dialogue — à la source de la mutation, pas ici.
                    setOpened((prev) => (prev && prev.site.id === site.id ? { ...prev, site } : prev));
                    void reload();
                }}
                onRemoved={
                    dialog?.site
                        ? () => {
                              setDialog(null);
                              setOpenedId(null);
                              invalidate('audience.list');
                              void reload();
                          }
                        : undefined
                }
            />
        </div>
    );
}

export default FeatureAudience;
