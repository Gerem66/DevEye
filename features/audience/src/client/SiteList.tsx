import { useDragReorder, type LiveOutlineProps } from 'deveye-sdk-client';
import type { AudienceEventsQuota, AudienceSite } from '../contracts/domain';

import { formatAgo, formatCount, siteStatus } from './format';
import styles from './style.module.css';

interface SiteListProps {
    /** Les sites, déjà dans l'ordre de l'utilisateur. */
    sites: AudienceSite[];
    /** Où en sont les vues du mois face à l'offre : un site qui ne mesure plus le dit. */
    eventsQuota: AudienceEventsQuota | null;
    /** Le halo de présence d'un site (`useLiveOutlines('l1')` de l'appelant). */
    outlineFor: (value: string | null) => LiveOutlineProps;
    /** Ranger est une écriture : sans le droit, la poignée n'existe pas. */
    canWrite: boolean;
    onOpen: (siteId: number) => void;
    onReorder: (ids: number[]) => void;
    onDragStateChange: (dragging: boolean) => void;
}

/**
 * La liste des sites suivis, réordonnable au glisser-déposer. Le geste vit dans
 * `useDragReorder`, le seul du SDK pour ça : ne restent ici que l'apparence de
 * la carte, de la poignée et de la barre d'insertion.
 */
export function SiteList({
    sites,
    eventsQuota,
    outlineFor,
    canWrite,
    onOpen,
    onReorder,
    onDragStateChange
}: SiteListProps) {
    const drag = useDragReorder<HTMLUListElement, HTMLLIElement>({
        ids: sites.map((s) => s.id),
        rowSelector: '[data-site-card]',
        onReorder: (ids) => onReorder(ids as number[]),
        onDragStateChange
    });

    return (
        <ul ref={drag.listRef} className={styles.grid}>
            {sites.map((site) => (
                <SiteCard
                    key={site.id}
                    site={site}
                    eventsQuota={eventsQuota}
                    outline={outlineFor(String(site.id))}
                    dragging={drag.draggingId === site.id}
                    onOpen={() => onOpen(site.id)}
                    onDragPointerDown={canWrite ? (e) => drag.onGripPointerDown(e, site.id) : undefined}
                />
            ))}
            {/* Un `<li>` et non un `<span>` : dans une `<ul>`, seul un `<li>` est
                un enfant valide. Sorti du flux par `position: absolute`, il
                n'occupe aucune cellule de la grille. */}
            <li ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
        </ul>
    );
}

interface SiteCardProps {
    site: AudienceSite;
    eventsQuota: AudienceEventsQuota | null;
    outline: LiveOutlineProps;
    dragging: boolean;
    onOpen: () => void;
    onDragPointerDown?: (e: React.PointerEvent) => void;
}

function SiteCard({ site, eventsQuota, outline, dragging, onOpen, onDragPointerDown }: SiteCardProps) {
    const status = siteStatus(site, eventsQuota);

    return (
        <li className={`${styles.card} ${dragging ? styles.cardDragging : ''}`} data-site-card='' {...outline}>
            {/* La poignée est sœur du corps cliquable et non son enfant : un clic parti
                d'ici ne peut pas remonter jusqu'à « ouvrir le site ». */}
            {onDragPointerDown && (
                <button
                    type='button'
                    className={styles.grip}
                    aria-label='Réordonner le site'
                    onPointerDown={onDragPointerDown}
                >
                    <span className='icon icon-drag' />
                </button>
            )}

            {/* `div role="button"` et non `<button>` : la carte contient des
                paragraphes, c'est-à-dire du contenu de flux, interdit dans un
                bouton dont le modèle de contenu est phrasé. */}
            <div
                className={styles.cardBody}
                role='button'
                tabIndex={0}
                onClick={onOpen}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen();
                    }
                }}
            >
                <div className={styles.cardMain}>
                    <p className={styles.cardName}>
                        <span className={styles.statusDot} data-tone={status.tone} aria-hidden='true' />
                        {site.name}
                        {site.foreign && (
                            <span
                                className={styles.statusTag}
                                data-tone='neutral'
                                title='Ce site appartient à un autre espace qui le partage ici'
                            >
                                partagé
                            </span>
                        )}
                    </p>
                    <p className={styles.cardMeta}>
                        {site.origins.length > 0 ? site.origins.join(' · ') : 'aucune origine : rien n’entre'}
                    </p>
                    <div className={styles.cardFoot}>
                        <span className={styles.statusTag} data-tone={status.tone}>
                            {status.label}
                        </span>
                        <span>{formatAgo(site.lastEventAt)}</span>
                        {site.projectCount > 0 && (
                            <span>
                                {site.projectCount} projet{site.projectCount > 1 ? 's' : ''}
                            </span>
                        )}
                    </div>
                </div>

                {/* Les deux nombres qu'on vient lire en parcourant la liste ; le reste
                    se regarde dans la fiche, pas de biais dans une carte. */}
                <div className={styles.cardStats}>
                    <span className={styles.cardStatValue}>{formatCount(site.visitors24h)}</span>
                    <span className={styles.cardStatLabel}>visiteurs · 24 h</span>
                    <span className={styles.cardStatSecond}>{formatCount(site.views24h)} vues</span>
                </div>
            </div>
        </li>
    );
}

export default SiteList;
