import styles from './AboutContent.module.css';

interface ExternalService {
    name: string;
    description: string;
}

const WEATHER_SERVICES: ExternalService[] = [
    { name: 'Open-Meteo', description: 'Prévisions météo et géocodage — fournisseur par défaut, sans clé API.' },
    { name: 'OpenWeatherMap', description: 'Fournisseur météo alternatif, activable avec votre propre clé API.' }
];

/** Services with a dedicated adapter for the home-screen shortcut previews (see src/Services/shortcutTemplates). */
const LINK_PREVIEW_SERVICES = ['GitHub', 'npm', 'Spotify', 'SoundCloud', 'Twitch', 'TikTok', 'Wikipédia', 'YouTube'];

/**
 * Body of the "About" info dialog, opened from the navbar's version pill.
 * Lists the third-party services DevEye talks to, so nothing calls out
 * beyond the workspace without the user knowing about it.
 */
export default function AboutContent() {
    return (
        <>
            <p>
                DevEye est votre tableau de bord personnel : raccourcis, mots de passe, notes, météo et supervision
                réunis au même endroit.
            </p>

            <div>
                <p className={styles.servicesTitle}>Services externes utilisés</p>
                <ul className={styles.serviceList}>
                    {WEATHER_SERVICES.map((service) => (
                        <li key={service.name} className={styles.serviceItem}>
                            <strong>{service.name}</strong>
                            <span>{service.description}</span>
                        </li>
                    ))}

                    <li className={styles.serviceItem}>
                        <strong>Aperçus de liens</strong>
                        <span>
                            Récupèrent titre, image et métadonnées des raccourcis d&apos;accueil. Services dédiés :
                        </span>
                        <div className={styles.serviceTags}>
                            {LINK_PREVIEW_SERVICES.map((name) => (
                                <span key={name} className={styles.serviceTag}>
                                    {name}
                                </span>
                            ))}
                        </div>
                        <span className={styles.serviceNote}>
                            Tout autre lien utilise un aperçu générique (Open Graph, favicon).
                        </span>
                    </li>
                </ul>
            </div>
        </>
    );
}
