import type { SavedSignature } from '../contracts/signatures';
import { HAND_FONT_FAMILY } from './fonts';
import styles from './pdf.module.css';
import { storedImageUrl } from './savedSignatures';

/** Une signature gardée, telle que la bibliothèque la montre : sur du papier, à l'encre. */
export function SavedPreview({ saved }: { saved: SavedSignature }) {
    const { data } = saved;
    switch (data.kind) {
        case 'path':
            return (
                <svg className={styles.savedSvg} viewBox={`0 0 ${data.width} ${data.height}`}>
                    <path
                        d={data.path}
                        fill='none'
                        stroke='currentColor'
                        strokeWidth={data.stroke}
                        strokeLinecap='round'
                        strokeLinejoin='round'
                    />
                </svg>
            );
        case 'text':
            return (
                <span className={styles.savedText} style={{ fontFamily: `'${HAND_FONT_FAMILY}', cursive` }}>
                    {data.text}
                </span>
            );
        case 'image':
            return <img className={styles.savedImage} src={storedImageUrl(data)} alt='' />;
    }
}
