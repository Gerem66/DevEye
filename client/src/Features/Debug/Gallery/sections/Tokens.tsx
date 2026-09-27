import { useMemo, useState } from 'react';

import { copyText } from '@/copyText';
import { themeTokens, type ThemeToken } from '../cssInventory';
import styles from '../Gallery.module.css';

function Swatch({ token }: { token: ThemeToken }) {
    const ref = `var(${token.name})`;
    if (token.kind === 'color') return <span className={styles.swatch} style={{ background: ref }} />;
    if (token.kind === 'shadow') return <span className={styles.swatchShadow} style={{ boxShadow: ref }} />;
    if (token.kind === 'length') {
        return token.group === 'radius' ? (
            <span className={styles.swatch} style={{ borderRadius: ref }} />
        ) : (
            <span className={styles.swatchLength} style={{ width: `min(${ref}, 48px)` }} />
        );
    }
    if (token.kind === 'font') return <span style={{ fontFamily: ref }}>Aa</span>;
    return null;
}

/** Tous les jetons du thème, groupés ; un clic copie `var(--nom)`. */
export default function Tokens() {
    const tokens = useMemo(themeTokens, []);
    const [copied, setCopied] = useState<string | null>(null);
    const groups = useMemo(() => {
        const byGroup = new Map<string, ThemeToken[]>();
        for (const t of tokens) byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), t]);
        return [...byGroup];
    }, [tokens]);

    const copy = async (name: string): Promise<void> => {
        if (await copyText(`var(${name})`)) setCopied(name);
    };

    return (
        <>
            <p className={styles.demoText}>
                {tokens.length} jetons lus dans les feuilles chargées, avec leur valeur dans le thème affiché. Cliquez
                pour copier la référence.
                {copied && <span className={styles.copied}> var({copied}) copié.</span>}
            </p>
            {groups.map(([group, list]) => (
                <div key={group} className={styles.specimen}>
                    <h4 className={styles.groupTitle}>{group}</h4>
                    <div className={styles.tokens}>
                        {list.map((t) => (
                            <button
                                key={t.name}
                                type='button'
                                className={styles.token}
                                onClick={() => void copy(t.name)}
                            >
                                <Swatch token={t} />
                                <span className={styles.tokenText}>
                                    <span className={styles.tokenName}>{t.name}</span>
                                    <span className={styles.tokenValue}>{t.value}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            ))}
        </>
    );
}
