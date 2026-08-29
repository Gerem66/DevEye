import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    useActiveWorkspace,
    useLiveItemTarget,
    useLiveOutlines,
    useResourceVersion,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';
import type { AudienceSite, AudienceUsage } from '../contracts/domain';

import { api } from './api';
import SiteDetail from './SiteDetail';
import SiteDialog from './SiteDialog';
import SiteList from './SiteList';
import styles from './style.module.css';

/**
 * Les sites suivis de l'espace actif. Feature de premier rang et non un onglet
 * des Projets : un site appartient à l'espace, plusieurs projets peuvent le
 * suivre, certains n'en servent aucun, et un projet ne fait qu'y pointer.
 *
 * Rien ici ne mesure quoi que ce soit : les visites entrent par une porte
 * publique que ce composant ne connaît pas, et cet écran ne fait que lire ce
 * qu'elle a écrit. D'où aussi l'absence de mot de passe, tout vivant à l'étage
 * ouvert.
 */
export function FeatureAudience(_props: FeatureViewProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('audience', 'write');
    const workspaceId = useActiveWorkspace()?.id ?? null;

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

    /**
     * Présence : « qui regarde quel site ». Un seul déclarant par niveau, ce
     * composant possède `l1`.
     *
     * Le même hook applique ce qu'une téléportation demande à ce niveau : elle
     * ouvre la feature et le site visé, au lieu de s'arrêter sur la liste. La
     * cible est rendue tant qu'elle n'est pas atteinte et jamais consommée,
     * d'où l'attente de la liste (`ready`) avant de vérifier que le site existe.
     */
    useLiveItemTarget('l1', openedId === null ? null : String(openedId), sites !== null, (value) => {
        if (value === null) {
            setOpenedId(null);
            return;
        }
        const id = Number(value);
        if (!Number.isInteger(id) || !sites?.some((s) => s.id === id)) return;
        setOpenedId(id);
    });
    const outlineFor = useLiveOutlines('l1');

    const reload = useCallback(async () => {
        try {
            const res = await api.send('audience.list', {});
            setSites(res.sites);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les sites.'));
        }
    }, []);

    useEffect(() => {
        // Une relecture réordonne la liste sous le pointeur : jamais pendant un glissé,
        // elle est retenue et rejouée au relâchement.
        if (dragging.current) {
            pendingReload.current = true;
            return;
        }
        void reload();
    }, [reload, workspaceId, listVersion]);

    const loadOpened = useCallback(async (siteId: number) => {
        try {
            const res = await api.send('audience.get', { siteId });
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
            // On range d'abord localement, pour que la carte reste là où on l'a lâchée
            // sans aller-retour, puis on persiste.
            setSites((prev) => {
                if (!prev) return prev;
                const byId = new Map(prev.map((s) => [s.id, s]));
                return siteIds.flatMap((id) => byId.get(id) ?? []);
            });
            api.send('audience.reorder', { siteIds }).catch(() => {
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
                        {/* Le bouton commun, monté sans condition : il se supprime
                            lui-même tant qu'aucune section n'existe à cette échelle. */}
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
                    // La fiche ouverte doit refléter le réglage tout de suite ; la liste
                    // se relit par l'invalidation posée dans le dialogue, à la source de
                    // la mutation.
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
