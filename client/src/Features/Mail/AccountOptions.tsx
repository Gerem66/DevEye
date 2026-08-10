import styles from './style.module.css';

interface AccountOptionsProps {
    /** No folder selected yet — there is nothing for the refresh to act on. */
    canRefresh: boolean;
    refreshing: boolean;
    onEdit: () => void;
    onRefresh: () => void;
    onDelete: () => void;
    onOpenSettings: () => void;
}

/**
 * Everything that acts on *this mailbox*, sitting between the selected-account
 * header and its folder tree — the only place in the feature where the scope is
 * unambiguously one account. The toolbar up top is deliberately left for global
 * actions (compose, feature settings); the refresh lived there before and read
 * as global when it never was.
 *
 * Actions only. Anything with a value to set goes behind the settings button,
 * into `AccountSettingsPopup` — a strip of buttons is the wrong place for a
 * field, and there will be more than one setting to hold.
 *
 * Le rafraîchissement est une relève, pas une reconstruction : il n'attend pas
 * le prochain passage de la synchro de fond, mais fait le même travail qu'elle.
 * La reconstruction du cache, elle, vit derrière le bouton de paramètres — même
 * icône, même endroit, deux gestes trop différents pour se ressembler.
 */
export function AccountOptions({
    canRefresh,
    refreshing,
    onEdit,
    onRefresh,
    onDelete,
    onOpenSettings
}: AccountOptionsProps) {
    return (
        <div className={styles.accountOptions}>
            <div className={styles.accountOptionsActions}>
                <button
                    type='button'
                    className={styles.iconBtn}
                    title='Modifier cette boîte mail'
                    aria-label='Modifier cette boîte mail'
                    onClick={onEdit}
                >
                    <span className='icon icon-edit' />
                </button>
                <button
                    type='button'
                    className={styles.iconBtn}
                    title='Relever le dossier ouvert maintenant'
                    aria-label='Relever le dossier ouvert maintenant'
                    disabled={!canRefresh || refreshing}
                    onClick={onRefresh}
                >
                    <span className={`icon icon-refresh ${refreshing ? styles.spinning : ''}`} />
                </button>
                <button
                    type='button'
                    className={`${styles.iconBtn} ${styles.accountOptionsDanger}`}
                    title='Supprimer cette boîte mail'
                    aria-label='Supprimer cette boîte mail'
                    onClick={onDelete}
                >
                    <span className='icon icon-trash' />
                </button>
            </div>

            <button
                type='button'
                className={styles.iconBtn}
                title='Paramètres de cette boîte mail'
                aria-label='Paramètres de cette boîte mail'
                onClick={onOpenSettings}
            >
                <span className='icon icon-settings' />
            </button>
        </div>
    );
}

export default AccountOptions;
