import { useWeather } from './store';
import { wmoIcon } from './wmoIcon';
import styles from './Weather.module.css';

/**
 * Aucune prop, c'est le contrat : tout vient du magasin du module, donc des
 * commandes weather.* autorisées côté serveur. L'hôte fournit le cadre et le titre.
 */
export default function WeatherTopbarWidget() {
    const { report } = useWeather();
    const current = report?.current ?? null;
    return (
        <span className={styles.topbarTemp} title={report?.label ?? 'Météo'}>
            {current ? `${wmoIcon(current.code)} ${Math.round(current.temperature)}°` : '—'}
        </span>
    );
}
