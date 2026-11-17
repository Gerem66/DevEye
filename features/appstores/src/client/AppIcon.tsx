import { useState } from 'react';

import styles from './style.module.css';

const SIZES = { mark: styles.appIconMark, row: undefined, sheet: styles.appIconLarge } as const;

/**
 * L'icône d'une app telle que ses stores la publient, et un carré neutre avant
 * sa sortie. L'image vient des serveurs d'Apple ou de Google, sans leur dire
 * d'où part la page.
 */
export function AppIcon({ src, size = 'row' }: { src: string | null; size?: keyof typeof SIZES }) {
    const [broken, setBroken] = useState<string | null>(null);
    const className = [styles.appIcon, SIZES[size]].filter(Boolean).join(' ');
    if (src === null || src === broken) {
        return (
            <span className={className} aria-hidden='true'>
                <span className='icon icon-appstores' />
            </span>
        );
    }
    return (
        <img
            className={className}
            src={src}
            alt=''
            referrerPolicy='no-referrer'
            loading='lazy'
            onError={() => setBroken(src)}
        />
    );
}

export default AppIcon;
