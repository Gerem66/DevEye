import type { HomeFeatureId } from '@deveye/types';

import { moduleManifest } from '@/sdk/registry';
import { isFeatureHidden } from '@/stores/maintenance';
import { useSiteUrl } from '@/stores/siteUrl';
import { catalogEntries } from '../catalog';
import { FeatureChip } from './FeaturesTab';
import { EXTERNAL_SERVICES, LINK_PREVIEW_SERVICES, type ExternalService } from './services';

import styles from './AboutContent.module.css';

function installed(id: string): boolean {
    return moduleManifest(id) !== undefined && !isFeatureHidden(id);
}

/**
 * Les services qui concernent ce serveur : ceux de l'instance officielle quand
 * il a un site vitrine, ceux d'une fonctionnalité quand l'une d'elles est là.
 */
export function useVisibleServices(): ExternalService[] {
    const official = useSiteUrl() !== null;
    return EXTERNAL_SERVICES.filter(
        (s) => (!s.official || official) && (s.features === undefined || s.features.some(installed))
    );
}

/** Les services affichés, les aperçus de liens comptés un par un. */
export function useServiceCount(): number {
    return useVisibleServices().length + LINK_PREVIEW_SERVICES.length;
}

export default function ServicesTab() {
    const services = useVisibleServices();

    return (
        <>
            <p>
                Les services auxquels DevEye fait appel, et ce que chacun reçoit. La plupart n’interviennent que si vous
                utilisez la fonctionnalité qui les appelle.
            </p>
            <ul className={styles.serviceList}>
                {services.map((service) => {
                    const chips = catalogEntries((service.features ?? []) as HomeFeatureId[]);
                    return (
                        <li key={service.name} className={styles.serviceItem}>
                            <strong>{service.name}</strong>
                            <span>{service.purpose}</span>
                            <span className={styles.serviceNote}>Reçoit : {service.receives}</span>
                            {chips.length > 0 && (
                                <div className={styles.chips}>
                                    {chips.map((entry) => (
                                        <FeatureChip key={entry.id} entry={entry} />
                                    ))}
                                </div>
                            )}
                        </li>
                    );
                })}

                <li className={styles.serviceItem}>
                    <strong>Aperçus de liens</strong>
                    <span>Récupèrent titre, image et métadonnées des raccourcis d’accueil. Services dédiés :</span>
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
        </>
    );
}
