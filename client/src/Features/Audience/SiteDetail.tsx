import { useState } from 'react';
import type { AudienceSite, AudienceUsage } from 'deveye-types';

import { Button, StatusBadge } from '@/Components';
import { FeatureSettingsButton } from '@/Components/FeatureSettings';
import { invalidate } from '@/stores/invalidation';
import { startTeleport } from '@/stores/live';
import { getActiveWorkspaceId } from '@/stores/workspace';
import { useStickyOffset } from '@/stickyOffset';
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
    onEdit: () => void;
    onSiteChanged: (site: AudienceSite) => void;
}

/**
 * La fiche d'un site : son en-tête, ses statistiques, et les projets qui le
 * suivent.
 *
 * Le corps est `SiteView`, exactement celui de l'onglet d'un projet. Ce
 * composant-ci n'ajoute que ce qui n'a de sens **que** dans la feature : le
 * retour à la liste, les réglages, l'installation, et l'interconnexion vers les
 * projets — qui n'aurait aucun sens dans l'onglet d'un projet, puisqu'on y est
 * déjà.
 */
export function SiteDetail({ site, usage, ingestOrigin, canWrite, onBack, onEdit, onSiteChanged }: SiteDetailProps) {
    const [installOpen, setInstallOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    // La barre de période de `SiteView` colle juste sous cet en-tête. Sa
    // hauteur est mesurée et non écrite en dur : elle change dès que le nom du
    // site passe à la ligne ou que les boutons se replient.
    const sticky = useStickyOffset<HTMLElement>();

    /**
     * Relire maintenant.
     *
     * Les chiffres se rafraîchissent seuls, mais au plus **une fois par minute
     * et par espace** : c'est la coalescence de l'ingestion, et c'est le bon
     * réglage pour une donnée qui se lit en tendance. Reste le moment où l'on
     * vient justement de faire quelque chose sur le site et où l'on veut voir
     * l'effet tout de suite — d'où ce bouton, qui ne fait qu'invalider les deux
     * clés concernées.
     *
     * Le tour de l'icône ne mesure rien : il acquitte le clic. La relecture est
     * quasi instantanée, et prétendre la chronométrer serait inventer un délai.
     */
    const refresh = () => {
        invalidate('audience.detail', 'audience.stats');
        setRefreshing(true);
        window.setTimeout(() => setRefreshing(false), 600);
    };

    return (
        <div className={styles.detail} style={sticky.style}>
            <header ref={sticky.ref} className={styles.detailHead}>
                {/* Le bouton de retour des autres fiches, à l'identique :
                    `Button` fantôme, flèche à gauche, le nom pluriel de la
                    liste — comme « Dépôts » (Git) et « Bases ». Une feature qui
                    invente son propre retour se remarque, et pas en bien. */}
                <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                    Sites
                </Button>

                <div className={styles.detailTitle}>
                    <h2 className={styles.detailName}>
                        {site.name}
                        {/* Sans cette pastille, rien ne distingue un site local
                            d'une fenêtre sur l'espace voisin. */}
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
                    {/* Rien à rafraîchir tant que rien n'est jamais entré : le
                        bouton n'apparaît qu'une fois la première mesure reçue,
                        sinon il proposerait de relire un écran vide. */}
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

                    {/* L'installation est mise en avant tant qu'aucune mesure
                        n'est arrivée : c'est la seule chose à faire à ce
                        moment-là, et la chercher dans un menu ferait perdre du
                        temps sur le seul écran où l'on est bloqué. */}
                    <Button
                        variant={site.lastEventAt === null ? 'primary' : 'secondary'}
                        icon='terminal'
                        onClick={() => setInstallOpen(true)}
                    >
                        Installer
                    </Button>
                    {/* `!site.foreign` : les réglages d'un site — origines,
                        rétention, clé — appartiennent à son espace. Le serveur
                        le refuse, l'écran ne le propose donc pas ; les chiffres,
                        eux, sont tout l'objet de la projection.

                        « Modifier » + icône `edit`, comme dans toutes les
                        fiches : « Paramètres » avec un engrenage, à côté du
                        bouton « Réglages » et son même engrenage, se lisait
                        comme deux fois le même bouton. */}
                    {canWrite && !site.foreign && (
                        <Button variant='secondary' icon='edit' onClick={onEdit}>
                            Modifier
                        </Button>
                    )}
                    {/* Les réglages de CE site : partage vers d'autres espaces,
                        restrictions par rôle. Le bouton se garde de lui-même. */}
                    <FeatureSettingsButton
                        scope={{ kind: 'item', feature: 'audience', itemId: site.id, itemLabel: site.name }}
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
                                {/* La téléportation est le chemin commun : le
                                    même que la feature Git emprunte pour son
                                    « ouvrir le projet ». Un canal de navigation
                                    dédié aurait fait un second mécanisme pour
                                    le même besoin. */}
                                <button
                                    type='button'
                                    className={styles.usageLink}
                                    onClick={() =>
                                        startTeleport(getActiveWorkspaceId() ?? 0, [
                                            'view:projects',
                                            `l1:project:${project.projectId}`
                                        ])
                                    }
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
