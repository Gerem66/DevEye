import { useState } from 'react';
import { Button, FeatureSettingsButton, openFeature, useResource } from 'deveye-sdk-client';
import type { AudienceClientProvider } from '@deveye/types/sdk/client';

import { api } from './api';
import Funnels from './Funnels';
import InstallDialog from './InstallDialog';
import SiteDialog from './SiteDialog';
import SiteView from './SiteView';
import styles from './style.module.css';

/**
 * Ce que le module offre aux écrans de l'app : l'onglet « Audience » d'un projet
 * compose la liste des sites de l'espace, un site relié montré en entier, et le
 * dialogue de création, sans importer le module.
 *
 * `LinkedSite` est autonome : l'hôte ne lui tend qu'un identifiant, le bloc
 * charge son site, suit les invalidations de la feature et porte son propre
 * dialogue d'installation. L'hôte ne connaît ni la forme d'un site, ni ses
 * commandes.
 */

interface LinkedSiteProps {
    siteId: number;
    canWrite: boolean;
    onUnlink: () => void;
}

/**
 * Un site du projet : sa barre collante, et les blocs partagés avec la feature.
 *
 * Fréquentation et entonnoirs sont empilés ici, là où la fiche du site les
 * range en sections d'un sommaire : un projet peut relier plusieurs sites, et
 * un sommaire par site ferait un écran de sommaires. Les retours n'y sont pas :
 * un tableau triable et son export n'ont pas leur place dans un onglet qui
 * empile des sites, et « Ouvrir l'Audience » y mène en un clic.
 */
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
            {/* L'intitulé et les actions sont passés à `SiteView`, qui les loge dans sa
                barre de période déjà collante : un second bandeau collant se serait
                empilé sous le premier. */}
            <SiteView
                site={site}
                heading={<h3 className={styles.blockTitle}>{site.name}</h3>}
                actions={
                    <div className={styles.detailActions}>
                        {/* L'installation, mise en avant tant qu'aucune mesure n'est
                            arrivée : c'est la seule chose à faire à ce moment-là. */}
                        <Button
                            variant={site.lastEventAt === null ? 'primary' : 'secondary'}
                            icon='terminal'
                            onClick={() => setInstallOpen(true)}
                        >
                            Installer
                        </Button>
                        {/* Les réglages du site, les mêmes que sur sa fiche : son
                            identité et sa suppression y vivent (onglet Général). Hors
                            du bloc d'écriture, un lecteur y a droit ; le bouton se
                            supprime seul quand aucune section n'est lisible. */}
                        <FeatureSettingsButton
                            scope={{ kind: 'item', feature: 'audience', itemId: String(site.id), itemLabel: site.name }}
                        />
                        {/* La feature sait mener aux projets d'un site ; l'onglet d'un
                            projet doit savoir mener au site. Par la téléportation, garde
                            d'accès comprise, et offert même sans droit d'écriture puisque
                            c'est une navigation. */}
                        <Button
                            variant='secondary'
                            icon='chevrons-right'
                            onClick={() => openFeature('audience', site.id)}
                        >
                            Ouvrir l’Audience
                        </Button>
                        {/* Destructeur, donc en bout de barre. La confirmation et le
                            déliement sont à l'hôte, qui seul tient le pointeur. */}
                        {canWrite && (
                            <Button variant='ghost' onClick={onUnlink}>
                                Délier
                            </Button>
                        )}
                    </div>
                }
            />

            <Funnels site={site} canWrite={canWrite} />

            {/* Le vrai dialogue de la feature, pas une copie : installer un site depuis
                un projet ou depuis sa fiche doit être le même geste. Pas d'`onRotated`,
                le dialogue ravive lui-même la fiche et `useResource` relit. */}
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
 * Le dialogue de création de la feature, pas une copie : Projets relie ce qui
 * vient d'être créé. Un site relié se règle par le bouton commun de `LinkedSite`.
 */
function LinkedSiteDialog({ open, onClose, onSaved }: LinkedSiteDialogProps) {
    return <SiteDialog open={open} onClose={onClose} onSaved={(site) => onSaved(site.id)} />;
}

export const clientProvider: AudienceClientProvider = {
    listSites: async () =>
        (await api.send('audience.list', {})).sites.map((s) => ({ id: s.id, name: s.name, foreign: s.foreign })),
    LinkedSite,
    SiteDialog: LinkedSiteDialog
};
