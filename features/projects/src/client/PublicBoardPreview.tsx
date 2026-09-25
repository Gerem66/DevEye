import type { CSSProperties } from 'react';
import { resolvePageAccent, type PageTheme, type PageThemeChoice } from '@deveye/types/sdk';

import { PUBLIC_BOARD_PALETTE } from '../contracts/domain';
import styles from './style.module.css';

/** Les cartes de chaque colonne de la vignette. */
const COLUMNS = [3, 2, 1];

function Miniature({ theme, accent }: { theme: PageTheme; accent: string }) {
    const palette = PUBLIC_BOARD_PALETTE[theme];
    const style = {
        '--pv-bg': palette.bg,
        '--pv-column': palette.column,
        '--pv-card': palette.card,
        '--pv-ink': palette.ink,
        '--pv-line': palette.line,
        '--pv-chip': palette.chip,
        '--pv-accent': resolvePageAccent(accent) ?? palette.accent
    } as CSSProperties;
    return (
        <div className={styles.pv} style={style}>
            <span className={styles.pvTitle} />
            <span className={styles.pvProgress}>
                <span />
            </span>
            <div className={styles.pvColumns}>
                {COLUMNS.map((count, column) => (
                    <div key={column} className={styles.pvColumn}>
                        {Array.from({ length: count }, (_, card) => (
                            <span key={card} className={styles.pvCard} />
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Un aperçu du tableau public, pour ne pas choisir à l'aveugle : sa silhouette,
 * aux couleurs que la page posera. En automatique, les deux thèmes côte à côte,
 * puisque chaque visiteur verra le sien.
 */
export default function PublicBoardPreview({ theme, accent }: { theme: PageThemeChoice; accent: string }) {
    const themes: PageTheme[] = theme === 'auto' ? ['light', 'dark'] : [theme];
    return (
        <div className={styles.pvRow} aria-hidden='true'>
            {themes.map((shown) => (
                <Miniature key={shown} theme={shown} accent={accent} />
            ))}
        </div>
    );
}
