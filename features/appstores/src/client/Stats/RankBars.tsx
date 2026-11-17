import { useState } from 'react';

import { formatCount, formatShare, plural } from '../format';
import styles from '../style.module.css';

/** Les lignes montrées d'emblée ; les autres se déplient à la demande. */
const SHOWN = 8;

export interface RankItem {
    key: string;
    label: string;
    downloads: number;
}

interface RankBarsProps {
    /** Non vide, les plus nombreux d'abord. */
    items: readonly RankItem[];
    /** Ce qu'on classe, au pluriel : « Afficher les 17 pays ». */
    noun: string;
    /** Une ligne qui s'ouvre, comme l'app d'un classement d'apps. */
    onPick?: (key: string) => void;
}

/** Un classement de téléchargements, chaque barre rapportée au premier. */
export function RankBars({ items, noun, onPick }: RankBarsProps) {
    const [all, setAll] = useState(false);

    const total = items.reduce((sum, item) => sum + item.downloads, 0);
    const longest = Math.max(1, items[0].downloads);
    const shown = all ? items : items.slice(0, SHOWN);

    return (
        <>
            <ol className={styles.rankList}>
                {shown.map((item) => {
                    const title = `${item.label} : ${plural(item.downloads, 'téléchargement', 'téléchargements')}`;
                    const content = (
                        <>
                            <span
                                className={styles.rankBar}
                                style={{ width: `${(item.downloads / longest) * 100}%` }}
                                aria-hidden='true'
                            />
                            <span className={styles.rankName}>{item.label}</span>
                            <span className={styles.rankCount}>
                                {formatCount(item.downloads)}
                                <span className={styles.rankShare}>
                                    {total > 0 ? formatShare(item.downloads / total) : ''}
                                </span>
                            </span>
                        </>
                    );
                    return onPick ? (
                        <li key={item.key}>
                            <button
                                type='button'
                                className={`${styles.rankRow} ${styles.rankPick}`}
                                title={title}
                                onClick={() => onPick(item.key)}
                            >
                                {content}
                            </button>
                        </li>
                    ) : (
                        <li key={item.key} className={styles.rankRow} title={title}>
                            {content}
                        </li>
                    );
                })}
            </ol>
            {items.length > SHOWN && (
                <button type='button' className={styles.rankMore} onClick={() => setAll(!all)}>
                    {all ? 'Afficher moins' : `Afficher les ${items.length} ${noun}`}
                </button>
            )}
        </>
    );
}

export default RankBars;
