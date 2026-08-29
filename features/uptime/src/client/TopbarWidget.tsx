import { useUptimeCount } from './store';
import styles from './style.module.css';

/**
 * Aucune prop, c'est le contrat : tout vient du magasin du module
 * (`uptime.count`), le même que la carte de l'accueil, d'une seule requête.
 * L'icône porte l'identité et l'état, pour que les deux compteurs de la barre
 * ne se confondent pas.
 */
export default function UptimeTopbarWidget() {
    const { total, up, down, loading } = useUptimeCount();
    const tone = down > 0 ? styles.statusAlert : total > 0 && up === total ? styles.statusOk : '';
    return (
        <>
            <span className={`icon icon-uptime ${styles.statusIcon} ${tone}`} />
            {loading ? '—' : `${up}/${total}`}
        </>
    );
}
