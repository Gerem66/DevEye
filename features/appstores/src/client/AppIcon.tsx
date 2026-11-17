import { useState } from 'react';
import type { AppStoresApp } from '../contracts/domain';

import { STORE_ORDER } from './format';
import styles from './style.module.css';

/**
 * L'icône de l'app telle que ses stores la publient, l'App Store d'abord, et
 * un carré neutre avant sa sortie. L'image vient des serveurs d'Apple ou de
 * Google, sans leur dire d'où part la page.
 */
export function AppIcon({ app, large = false }: { app: AppStoresApp; large?: boolean }) {
    const src =
        STORE_ORDER.map((store) => app.listings.find((listing) => listing.store === store)?.icon).find(Boolean) ?? null;
    const [broken, setBroken] = useState<string | null>(null);
    const className = large ? `${styles.appIcon} ${styles.appIconLarge}` : styles.appIcon;
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
