import { useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    invalidate,
    openFeature,
    StatusBadge,
    useLiveSegment,
    useStickyOffset
} from 'deveye-sdk-client';
import type { AudienceSite, AudienceUsage } from '../contracts/domain';

import Forms from './Forms/Forms';
import Funnels from './Funnels';
import HubTrend from './HubTrend';
import InstallDialog from './InstallDialog';
import SiteHub, { type SiteSection } from './SiteHub';
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

/** `null` = le sommaire. */
type Section = SiteSection | null;

const SECTION_LABELS: Record<SiteSection, string> = {
    traffic: 'Fréquentation',
    funnels: 'Entonnoirs',
    forms: 'Retours'
};

/**
 * La fiche d'un site : son en-tête, un sommaire à trois cartes, et la section
 * qu'on en ouvre. Le corps de chaque section est le même que celui de l'onglet
 * d'un projet ; ce composant n'ajoute que ce qui n'a de sens que dans la
 * feature (retour à la liste, réglages, installation, interconnexion).
 *
 * Trois cartes plutôt qu'une page : la fréquentation, les parcours et les
 * retours ne répondent pas à la même question, et les empiler rendait la fiche
 * trop longue pour qu'on y trouve quoi que ce soit.
 */
export function SiteDetail({ site, usage, ingestOrigin, canWrite, onBack, onSiteChanged }: SiteDetailProps) {
    const [installOpen, setInstallOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [section, setSection] = useState<Section>(null);

    // Présence : « qui regarde quoi dans ce site ». `Audience` possède `l1` (le
    // site), cette fiche possède `l2` (la section) : un seul déclarant par niveau.
    useLiveSegment('l2', section);

    // La barre de période des sections colle juste sous cet en-tête. Sa hauteur est
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
        invalidate('audience.detail', 'audience.stats', 'audience.forms');
        setRefreshing(true);
        window.setTimeout(() => setRefreshing(false), 600);
    };

    return (
        <div className={styles.detail} style={sticky.style}>
            <header ref={sticky.ref} className={styles.detailHead}>
                {/* Le bouton de retour des autres fiches, à l'identique : `Button`
                    fantôme, flèche à gauche. Depuis une section il ramène au sommaire,
                    qui est le niveau juste au-dessus. */}
                <Button variant='ghost' icon='arrow-left' onClick={section === null ? onBack : () => setSection(null)}>
                    {section === null ? 'Sites' : site.name}
                </Button>

                <div className={styles.detailTitle}>
                    <h2 className={styles.detailName}>
                        {section === null ? site.name : SECTION_LABELS[section]}
                        {/* Sans cette pastille, rien ne distingue un site local d'une
                            fenêtre sur l'espace voisin. */}
                        {site.foreign && (
                            <span title='Ce site appartient à un autre espace qui le partage ici'>
                                {' '}
                                <StatusBadge tone='accent'>partagé</StatusBadge>
                            </span>
                        )}
                    </h2>
                    {section === null && site.description && <p className={styles.detailDesc}>{site.description}</p>}
                </div>

                <div className={styles.detailActions}>
                    <Button variant='secondary' onClick={refresh} aria-label='Rafraîchir' title='Rafraîchir'>
                        <span className={`icon icon-refresh ${refreshing ? styles.spinning : ''}`} aria-hidden='true' />
                    </Button>

                    {/* Chaque section a son installation : la balise au sommaire,
                        la mesure et ses appels sur Fréquentation, les signaux nommés
                        sur Entonnoirs. Les Retours portent le leur, avec le
                        formulaire ouvert — celui-ci ne saurait pas lequel montrer.
                        Le bouton passe en avant tant que rien n'est arrivé : c'est
                        la seule chose à faire à ce moment-là. */}
                    {section !== 'forms' && (
                        <Button
                            variant={site.lastEventAt === null ? 'primary' : 'secondary'}
                            icon='terminal'
                            onClick={() => setInstallOpen(true)}
                        >
                            Installer
                        </Button>
                    )}
                    {/* Les réglages de ce site, son identité et sa suppression
                        comprises (onglet Général), avec le partage et les
                        restrictions par rôle. Le bouton se garde lui-même. Supprimé
                        ou déplacé depuis la coquille, le site n'est plus ici : la
                        fiche revient à la liste. */}
                    {/* Ouvert depuis une section, il tombe sur l'onglet de cette
                        section : chercher « Fréquentation » alors qu'on la regarde
                        déjà est un clic qui n'apprend rien. Depuis le sommaire ou
                        les entonnoirs, la coquille garde son choix habituel. */}
                    <FeatureSettingsButton
                        scope={{ kind: 'item', feature: 'audience', itemId: String(site.id), itemLabel: site.name }}
                        initialSection={section === 'traffic' || section === 'forms' ? section : undefined}
                        onGone={onBack}
                    />
                </div>
            </header>

            {!site.active && (
                <p className={styles.notice}>
                    La mesure est éteinte : plus rien n’entre, retours compris. L’historique ne bouge plus.
                </p>
            )}

            {section === null && <SiteHub site={site} onOpen={setSection} />}
            {section === 'traffic' && <SiteView site={site} />}
            {section === 'funnels' && <Funnels site={site} canWrite={canWrite} />}
            {section === 'forms' && <Forms site={site} ingestOrigin={ingestOrigin} canWrite={canWrite} />}

            {section === null && usage.length > 0 && (
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

            {/* Tout en bas du sommaire : sous les trois cartes et sous les projets,
                pour que la page finisse sur ce qu'on regarde, pas sur du vide. */}
            {section === null && <HubTrend site={site} onOpen={() => setSection('traffic')} />}

            <InstallDialog
                open={installOpen}
                scope={section === 'traffic' || section === 'funnels' ? section : 'site'}
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
