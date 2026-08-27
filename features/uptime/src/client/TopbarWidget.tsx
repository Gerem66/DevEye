import { useUptimeCount } from './store';
import styles from './style.module.css';

/**
 * Le mini-widget de topbar : services confirmés en ligne sur services
 * surveillés.
 *
 * Aucune prop, c'est le contrat : tout ce qu'il montre vient du magasin du
 * module (`uptime.count`, autorisée côté serveur contre les droits de
 * l'appelant), le même que la carte de l'accueil, d'une seule requête.
 * L'hôte fournit le cadre (`statusItem`) et le titre ; le module ne rend que
 * l'icône et le chiffre.
 *
 * The icon carries both the identity (which widget is this?) and the state,
 * so the two count widgets can't be mistaken for one another at a glance.
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
