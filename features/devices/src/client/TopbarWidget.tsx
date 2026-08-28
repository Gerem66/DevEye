import { useDevices } from './store';
import styles from './style.module.css';

/**
 * Le mini-widget de topbar : appareils en ligne sur appareils enrôlés (les
 * archivés exclus, ce sont d'anciennes machines gardées pour leur historique).
 *
 * Aucune prop, c'est le contrat : tout ce qu'il montre vient du magasin du
 * module (`devices.list`, autorisée côté serveur contre les droits de
 * l'appelant), le même que la tuile et Monitoring. L'hôte fournit le cadre
 * (`statusItem`) et le titre ; le module ne rend que l'icône et le chiffre.
 */
export default function DevicesTopbarWidget() {
    const { devices: all } = useDevices();
    const devices = all.filter((d) => d.status !== 'archived');
    const online = devices.filter((d) => d.online).length;
    return (
        <>
            <span className={`icon icon-server ${styles.statusIcon} ${online > 0 ? styles.statusOk : ''}`} />
            {online}/{devices.length}
        </>
    );
}
