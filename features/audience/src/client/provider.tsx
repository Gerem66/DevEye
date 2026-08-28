import { useState } from 'react';
import { Button, FeatureSettingsButton, openFeature, useResource } from 'deveye-sdk-client';
import type { AudienceClientProvider } from '@deveye/types/sdk/client';

import { api } from './api';
import InstallDialog from './InstallDialog';
import SiteDialog from './SiteDialog';
import SiteView from './SiteView';
import styles from './style.module.css';

/**
 * Ce que le module offre aux écrans de l'app (`AUDIENCE_CLIENT_PROVIDER`) :
 * l'onglet « Audience » d'un projet compose la liste des sites de l'espace,
 * un site relié montré en entier, et le dialogue de création, sans importer
 * le module.
 *
 * `LinkedSite` est autonome, et c'est la différence avec l'ancien bloc que
 * Projets écrivait lui-même : l'hôte ne lui tend qu'un identifiant, et le
 * bloc charge son site, suit les invalidations de la feature (la fiche, que
 * le battement de l'ingestion ravive avec les chiffres) et porte son propre
 * dialogue d'installation. L'hôte ne connaît ni la forme d'un site, ni ses
 * commandes.
 */

interface LinkedSiteProps {
    siteId: number;
    canWrite: boolean;
    onUnlink: () => void;
}

/** Un site du projet : sa barre collante, et le contenu partagé avec la feature. */
function LinkedSite({ siteId, canWrite, onUnlink }: LinkedSiteProps) {
    const { data, error } = useResource(
        'audience.detail',
        () => api.send('audience.get', { siteId }),
        'Impossible de charger ce site.',
        [siteId]
    );
    const [installOpen, setInstallOpen] = useState(false);

    if (!data) return <p className={error ? styles.error : styles.empty}>{error ?? 'Chargement…'}</p>;
    const { site, ingestOrigin } = data;

    return (
        <section className={styles.linkedBlock}>
            {/* L'intitulé et les actions sont passés à `SiteView`, qui
                les loge dans sa barre de période déjà collante. Un
                second bandeau collant au-dessus se serait empilé sous le
                premier, ou aurait glissé dessous. */}
            <SiteView
                site={site}
                canWrite={canWrite}
                heading={<h3 className={styles.blockTitle}>{site.name}</h3>}
                actions={
                    <div className={styles.detailActions}>
                        {/* L'installation, comme dans la fiche : mise en avant
                            tant qu'aucune mesure n'est arrivée, c'est la seule
                            chose à faire à ce moment-là. */}
                        <Button
                            variant={site.lastEventAt === null ? 'primary' : 'secondary'}
                            icon='terminal'
                            onClick={() => setInstallOpen(true)}
                        >
                            Installer
                        </Button>
                        {/* Les réglages de CE site (mesure, visiteurs,
                            conservation, partage, permissions), hors du bloc
                            d'écriture : un lecteur y a droit. Le bouton se
                            supprime seul quand aucune section n'est lisible. */}
                        <FeatureSettingsButton
                            scope={{ kind: 'item', feature: 'audience', itemId: site.id, itemLabel: site.name }}
                        />
                        {/* Le sens qui manquerait sinon : la feature sait
                            mener aux projets d'un site, l'onglet d'un
                            projet doit savoir mener au site. Par la
                            téléportation, comme partout : le chemin dit
                            « ouvre la feature, et dedans, ce site-là »,
                            garde d'accès comprise. Offert même sans droit
                            d'écriture, c'est une navigation. `openFeature`
                            écrit le chemin ; le module ne l'écrit jamais
                            lui-même. */}
                        <Button
                            variant='secondary'
                            icon='chevrons-right'
                            onClick={() => openFeature('audience', site.id)}
                        >
                            Ouvrir l’Audience
                        </Button>
                        {/* Destructeur, donc en bout de barre et confirmé. La
                            confirmation et le déliement sont à l'hôte, qui
                            seul tient le pointeur. */}
                        {canWrite && (
                            <Button variant='ghost' onClick={onUnlink}>
                                Délier
                            </Button>
                        )}
                    </div>
                }
            />

            {/* Le vrai dialogue de la feature, pas une copie : installer un
                site depuis un projet ou depuis sa fiche doit être le même
                geste. Pas d'`onRotated` : après un renouvellement de clé, le
                dialogue ravive lui-même la fiche, et `useResource` relit. */}
            <InstallDialog
                open={installOpen}
                site={site}
                ingestOrigin={ingestOrigin}
                canWrite={canWrite}
                onClose={() => setInstallOpen(false)}
            />
        </section>
    );
}

interface LinkedSiteDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (siteId: number) => void;
}

/**
 * Le dialogue de la feature, en mode création seulement : c'est le seul cas
 * de Projets, qui relie ce qui vient d'être créé. La modification passe par
 * la fiche du site, dans la feature.
 */
function LinkedSiteDialog({ open, onClose, onSaved }: LinkedSiteDialogProps) {
    return <SiteDialog open={open} site={null} onClose={onClose} onSaved={(site) => onSaved(site.id)} />;
}

export const clientProvider: AudienceClientProvider = {
    listSites: async () => (await api.send('audience.list', {})).sites.map((s) => ({ id: s.id, name: s.name })),
    LinkedSite,
    SiteDialog: LinkedSiteDialog
};
