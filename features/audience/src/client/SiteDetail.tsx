import { useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    invalidate,
    openFeature,
    StatusBadge,
    useStickyOffset
} from 'deveye-sdk-client';
import type { AudienceSite, AudienceUsage } from '../contracts/domain';

import InstallDialog from './InstallDialog';
import SiteView from './SiteView';
import styles from './style.module.css';

interface SiteDetailProps {
    site: AudienceSite;
    usage: AudienceUsage[];
    /** L'adresse de la balise, telle que le serveur la connaît. */
    ingestOrigin: string;
    canWrite: boolean;
    onBack: () => void;
    onSiteChanged: (site: AudienceSite) => void;
}

/**
 * La fiche d'un site : son en-tête, ses statistiques, et les projets qui le
 * suivent. Le corps est `SiteView`, exactement celui de l'onglet d'un projet ;
 * ce composant n'ajoute que ce qui n'a de sens que dans la feature (retour à la
 * liste, réglages, installation, interconnexion vers les projets).
 */
export function SiteDetail({ site, usage, ingestOrigin, canWrite, onBack, onSiteChanged }: SiteDetailProps) {
    const [installOpen, setInstallOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    // La barre de période de `SiteView` colle juste sous cet en-tête. Sa hauteur est
    // mesurée et non écrite en dur : elle change dès que le nom du site passe à la ligne
    // ou que les boutons se replient.
    const sticky = useStickyOffset<HTMLElement>();

    /**
     * Les chiffres se rafraîchissent seuls, mais au plus une fois par minute et
     * par espace : ce bouton sert au moment où l'on vient de faire quelque chose
     * sur le site et où l'on veut voir l'effet tout de suite.
     *
     * Le tour de l'icône ne mesure rien, il acquitte le clic : la relecture est
     * quasi instantanée, et la chronométrer inventerait un délai.
     */
    const refresh = () => {
        invalidate('audience.detail', 'audience.stats');
        setRefreshing(true);
        window.setTimeout(() => setRefreshing(false), 600);
    };

    return (
        <div className={styles.detail} style={sticky.style}>
            <header ref={sticky.ref} className={styles.detailHead}>
                {/* Le bouton de retour des autres fiches, à l'identique : `Button`
                    fantôme, flèche à gauche, le nom pluriel de la liste. */}
                <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                    Sites
                </Button>

                <div className={styles.detailTitle}>
                    <h2 className={styles.detailName}>
                        {site.name}
                        {/* Sans cette pastille, rien ne distingue un site local d'une
                            fenêtre sur l'espace voisin. */}
                        {site.foreign && (
                            <span title='Ce site appartient à un autre espace qui le partage ici'>
                                {' '}
                                <StatusBadge tone='accent'>partagé</StatusBadge>
                            </span>
                        )}
                    </h2>
                    {site.description && <p className={styles.detailDesc}>{site.description}</p>}
                </div>

                <div className={styles.detailActions}>
                    {/* Rien à rafraîchir tant que rien n'est entré : sinon le bouton
                        proposerait de relire un écran vide. */}
                    {site.lastEventAt !== null && (
                        <Button
                            variant='secondary'
                            onClick={refresh}
                            aria-label='Rafraîchir les statistiques'
                            title='Rafraîchir les statistiques'
                        >
                            <span
                                className={`icon icon-refresh ${refreshing ? styles.spinning : ''}`}
                                aria-hidden='true'
                            />
                        </Button>
                    )}

                    {/* L'installation est mise en avant tant qu'aucune mesure n'est
                        arrivée : c'est la seule chose à faire à ce moment-là. */}
                    <Button
                        variant={site.lastEventAt === null ? 'primary' : 'secondary'}
                        icon='terminal'
                        onClick={() => setInstallOpen(true)}
                    >
                        Installer
                    </Button>
                    {/* Les réglages de ce site, son identité et sa suppression
                        comprises (onglet Général), avec le partage et les
                        restrictions par rôle. Le bouton se garde lui-même. Supprimé
                        ou déplacé depuis la coquille, le site n'est plus ici : la
                        fiche revient à la liste. */}
                    <FeatureSettingsButton
                        scope={{ kind: 'item', feature: 'audience', itemId: String(site.id), itemLabel: site.name }}
                        onGone={onBack}
                    />
                </div>
            </header>

            {!site.active && (
                <p className={styles.notice}>
                    La mesure est éteinte : plus rien n’entre. L’historique ci-dessous ne bouge plus.
                </p>
            )}

            <SiteView site={site} canWrite={canWrite} />

            {usage.length > 0 && (
                <section className={styles.panel}>
                    <h3 className={styles.panelTitle}>Projets qui suivent ce site</h3>
                    <ul className={styles.usageList}>
                        {usage.map((project) => (
                            <li key={project.projectId}>
                                {/* La téléportation est le chemin commun : un canal de
                                    navigation dédié ferait un second mécanisme pour le
                                    même besoin. */}
                                <button
                                    type='button'
                                    className={styles.usageLink}
                                    onClick={() => openFeature('projects', project.projectId)}
                                >
                                    {project.title}
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <InstallDialog
                open={installOpen}
                site={site}
                ingestOrigin={ingestOrigin}
                canWrite={canWrite}
                onClose={() => setInstallOpen(false)}
                onRotated={onSiteChanged}
            />
        </div>
    );
}

export default SiteDetail;
