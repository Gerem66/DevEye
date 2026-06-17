import styles from './style.module.css';
import PasswordRow from './passwordRow';

/** Skeleton shown while the password list loads. */
function LoadingTable() {
    return (
        <section className={`${styles.categoryCard} ${styles.loadingCard}`}>
            <h3 className={styles.categoryTitle}>Chargement…</h3>
            <div className={styles.tableWrap}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th style={{ width: '20%' }}>Service</th>
                            <th>{"Nom d'utilisateur / Email"}</th>
                            <th style={{ width: '20%' }}>Mot de passe</th>
                            <th style={{ width: '10%' }}>Statut</th>
                            <th style={{ width: '5%' }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        <PasswordRow password={null} />
                        <PasswordRow password={null} />
                        <PasswordRow password={null} />
                    </tbody>
                </table>
            </div>
        </section>
    );
}

export default LoadingTable;
