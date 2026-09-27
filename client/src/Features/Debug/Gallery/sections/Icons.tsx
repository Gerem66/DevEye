import { useMemo, useState } from 'react';

import TextInput from '@/Components/TextInput';
import { copyText } from '@/copyText';
import { iconNames } from '../cssInventory';
import styles from '../Gallery.module.css';

/** Toutes les icônes déclarées ; un clic copie la classe. */
export default function Icons() {
    const names = useMemo(iconNames, []);
    const [query, setQuery] = useState('');
    const [copied, setCopied] = useState<string | null>(null);
    const shown = names.filter((n) => n.includes(query.trim().toLowerCase()));

    const copy = async (name: string): Promise<void> => {
        if (await copyText(`icon icon-${name}`)) setCopied(name);
    };

    return (
        <>
            <TextInput
                type='search'
                placeholder={`Chercher parmi ${names.length} icônes`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            {copied && <span className={styles.copied}>icon icon-{copied} copié.</span>}
            <div className={styles.icons}>
                {shown.map((name) => (
                    <button key={name} type='button' className={styles.iconCell} onClick={() => void copy(name)}>
                        <span className={`icon icon-${name} ${styles.iconGlyph}`} />
                        <span className={styles.iconName}>{name}</span>
                    </button>
                ))}
            </div>
        </>
    );
}
