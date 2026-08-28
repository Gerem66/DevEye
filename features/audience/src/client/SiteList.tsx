import { useDragReorder, type LiveOutlineProps } from 'deveye-sdk-client';
import type { AudienceSite } from '../contracts/domain';

import { formatAgo, formatCount } from './format';
import styles from './style.module.css';

interface SiteListProps {
    /** Les sites, déjà dans l'ordre de l'utilisateur. */
    sites: AudienceSite[];
    /** Le halo de présence d'un site (`useLiveOutlines('l1')` de l'appelant). */
    outlineFor: (value: string | null) => LiveOutlineProps;
    /** Ranger est une écriture : sans le droit, la poignée n'existe pas. */
    canWrite: boolean;
    onOpen: (siteId: number) => void;
    onReorder: (ids: number[]) => void;
    onDragStateChange: (dragging: boolean) => void;
}

/**
 * La liste des sites suivis, réordonnable au glisser-déposer.
 *
 * Le geste vit dans `useDragReorder`, le seul du SDK pour ça, partagé avec
 * Uptime, Git, Monitoring et les bases. Ne restent ici que l'apparence de la
 * carte, celle de la poignée et celle de la barre d'insertion.
 */
export function SiteList({ sites, outlineFor, canWrite, onOpen, onReorder, onDragStateChange }: SiteListProps) {
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
    outline: LiveOutlineProps;
    dragging: boolean;
    onOpen: () => void;
    onDragPointerDown?: (e: React.PointerEvent) => void;
}

/**
 * Trois états, et un seul est alarmant.
 *
 * « en attente » est l'état normal d'un site qu'on vient de déclarer, pas une
 * panne : le peindre en rouge ferait passer une installation en cours pour un
 * incident. C'est la même règle que l'état `unknown` d'une base de données.
 */
function toneOf(site: AudienceSite): { label: string; tone: 'neutral' | 'online' | 'danger' } {
    if (!site.active) return { label: 'éteint', tone: 'danger' };
    if (site.lastEventAt === null) return { label: 'en attente', tone: 'neutral' };
    return { label: 'actif', tone: 'online' };
}

function SiteCard({ site, outline, dragging, onOpen, onDragPointerDown }: SiteCardProps) {
    const status = toneOf(site);

    return (
        <li className={`${styles.card} ${dragging ? styles.cardDragging : ''}`} data-site-card='' {...outline}>
            {/* La poignée est sœur du corps cliquable, et non son enfant : un
                clic parti d'ici ne peut donc pas remonter jusqu'à « ouvrir le
                site », même sans le neutraliser. */}
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
                        {site.origins.length > 0 ? site.origins.join(' · ') : 'toutes origines acceptées'}
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

                {/* Les deux nombres qu'on vient lire en parcourant la liste. Le
                    reste — provenances, appareils, entonnoirs — se regarde dans
                    la fiche, pas de biais dans une carte. */}
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
