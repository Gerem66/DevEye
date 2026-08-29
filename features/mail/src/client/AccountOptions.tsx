import styles from './style.module.css';

interface AccountOptionsProps {
    /** No folder selected yet — there is nothing for the refresh to act on. */
    canRefresh: boolean;
    refreshing: boolean;
    /**
     * Projetée d'un autre espace : modifier ses identifiants et la supprimer
     * restent chez elle, et le serveur les refuse d'ici. Seule la relève, un
     * geste de fenêtre, est proposée.
     */
    foreign: boolean;
    onEdit: () => void;
    onRefresh: () => void;
    onDelete: () => void;
}

/**
 * Everything that acts on *this mailbox*, sitting between the selected-account
 * header and its folder tree: the only place in the feature where the scope is
 * unambiguously one account, the toolbar up top being left for global actions
 * (compose, feature settings).
 *
 * Actions only. Anything with a value to set lives in the settings dialog of the
 * selected account: a strip of buttons is the wrong place for a field.
 *
 * Le rafraîchissement est une relève, pas une reconstruction : il fait le même
 * travail que la synchro de fond, sans attendre son prochain passage. La
 * reconstruction du cache vit dans l'onglet Synchronisation des réglages.
 */
export function AccountOptions({ canRefresh, refreshing, foreign, onEdit, onRefresh, onDelete }: AccountOptionsProps) {
    return (
        <div className={styles.accountOptions}>
            <div className={styles.accountOptionsActions}>
                {!foreign && (
                    <button
                        type='button'
                        className={styles.iconBtn}
                        title='Modifier cette boîte mail'
                        aria-label='Modifier cette boîte mail'
                        onClick={onEdit}
                    >
                        <span className='icon icon-edit' />
                    </button>
                )}
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
                {!foreign && (
                    <button
                        type='button'
                        className={`${styles.iconBtn} ${styles.accountOptionsDanger}`}
                        title='Supprimer cette boîte mail'
                        aria-label='Supprimer cette boîte mail'
                        onClick={onDelete}
                    >
                        <span className='icon icon-trash' />
                    </button>
                )}
            </div>
        </div>
    );
}

export default AccountOptions;
