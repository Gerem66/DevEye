import { openSpotlight } from '@/stores/spotlight';
import styles from './SearchButton.module.css';
import pill from './TopbarPill.module.css';

/** La loupe : ouvre la recherche des fonctionnalités. En organisation, un simple aperçu. */
export function SearchButton({ editing = false }: { editing?: boolean }) {
    return (
        <button
            type='button'
            className={`${pill.pill} ${pill.square} ${styles.button}`}
            title='Rechercher une fonctionnalité'
            aria-label='Rechercher une fonctionnalité'
            onClick={editing ? undefined : () => openSpotlight()}
        >
            <span className='icon icon-search' />
        </button>
    );
}
