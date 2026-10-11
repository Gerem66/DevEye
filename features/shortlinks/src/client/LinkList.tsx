import { useLiveOutlines } from 'deveye-sdk-client';

import { SHORTLINK_RECENT_DAYS, type Shortlink } from '../contracts/domain';
import CopyLink from './CopyLink';
import { displayTitle, hostOf, plural, shareUrlOf } from './format';
import LinkStatus from './LinkStatus';
import Sparkline from './Stats/Sparkline';
import styles from './style.module.css';

/**
 * Les liens de l'espace. Toute la ligne ouvre la fiche, sauf le bouton de
 * copie, posé à côté : un bouton dans un bouton ne se clique pas.
 */
export default function LinkList({ links, onOpen }: { links: readonly Shortlink[]; onOpen: (id: number) => void }) {
    const outlineFor = useLiveOutlines('l1');
    return (
        <ul className={styles.list}>
            {links.map((link) => {
                const address = shareUrlOf(link);
                const recent = link.recent.reduce((sum, value) => sum + value, 0);
                return (
                    <li key={link.id} className={styles.row} {...outlineFor(String(link.id))}>
                        <button type='button' className={styles.rowMain} onClick={() => onOpen(link.id)}>
                            <span className={styles.rowText}>
                                <span className={styles.rowTop}>
                                    <span className={styles.rowTitle}>{displayTitle(link)}</span>
                                    <LinkStatus link={link} />
                                </span>
                                <span className={styles.rowAddress}>{address.replace(/^https?:\/\//, '')}</span>
                                <span className={styles.rowMeta}>vers {hostOf(link.targets.default)}</span>
                            </span>
                            <span
                                className={styles.rowTrend}
                                title={`${plural(recent, 'visite', 'visites')} sur les ${SHORTLINK_RECENT_DAYS} derniers jours`}
                            >
                                <Sparkline values={link.recent} />
                                <span className={styles.rowVisits}>
                                    <strong>{plural(recent, 'visite', 'visites')}</strong>
                                    <span className={styles.rowVisitsSpan}>{SHORTLINK_RECENT_DAYS} jours</span>
                                </span>
                            </span>
                        </button>
                        <span className={styles.rowCopy}>
                            <CopyLink url={address} variant='ghost' />
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}
