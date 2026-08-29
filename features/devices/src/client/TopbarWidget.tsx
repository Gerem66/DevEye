import { useDevices } from './store';
import styles from './style.module.css';

/**
 * Le mini-widget de topbar : appareils en ligne sur appareils enrôlés (archivés
 * exclus). Aucune prop : tout vient du magasin du module ; l'hôte fournit le
 * cadre et le titre, le module ne rend que l'icône et le chiffre.
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
