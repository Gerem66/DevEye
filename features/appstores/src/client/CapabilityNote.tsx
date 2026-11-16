import { FeatureSettingsButton } from 'deveye-sdk-client';
import type { AppStore, AppStoresApp, AppStoresCapability, AppStoresSource } from '../contracts/domain';

import {
    CAPABILITY_NEEDS,
    CAPABILITY_OBJECTS,
    joinFr,
    ON_STORE,
    STORE_CAPABILITIES,
    STORE_LABELS,
    STORE_ORDER
} from './format';
import styles from './style.module.css';

interface CapabilityNoteProps {
    app: AppStoresApp;
    /** Les comptes de l'espace ; `null` pour qui ne peut pas les lister. */
    sources: readonly AppStoresSource[] | null;
    /** Ce que le bloc montre. */
    capabilities: readonly AppStoresCapability[];
    /** Les stores dont le bloc n'a rien relevé : la phrase neutre, quand la clé n'est pas lisible d'ici. */
    empty?: readonly AppStore[];
}

interface Line {
    store: AppStore;
    text: string;
    /** La phrase vient de la clé elle-même : le lien vers les comptes a un sens. */
    known: boolean;
}

/**
 * Ce que la clé d'une fiche ne sait pas lire, dit là où le bloc resterait vide :
 * un zéro se lirait comme une mesure. Sans accès aux comptes (un lecteur, une
 * app partagée d'ailleurs), une phrase neutre pour les stores restés vides.
 */
export function CapabilityNote({ app, sources, capabilities, empty = [] }: CapabilityNoteProps) {
    const lines: Line[] = STORE_ORDER.flatMap((store): Line[] => {
        const listing = app.listings.find((candidate) => candidate.store === store);
        if (!listing || listing.sourceId === null) return [];
        const source = sources?.find((candidate) => candidate.id === listing.sourceId);
        if (!source) {
            if (!empty.includes(store)) return [];
            return [
                {
                    store,
                    text: `${STORE_LABELS[store]} : rien n’est relevé ici pour l’instant. La clé de ce store ne le permet peut-être pas, un membre qui gère les comptes de store peut le vérifier.`,
                    known: false
                }
            ];
        }
        if (source.checkedAt === null) return [];
        const missing = capabilities.filter(
            (capability) => STORE_CAPABILITIES[store].includes(capability) && !source.capabilities.includes(capability)
        );
        if (missing.length === 0) return [];
        const need = CAPABILITY_NEEDS[store][missing[0]];
        return [
            {
                store,
                text:
                    `La clé « ${source.label} » ne lit pas ${joinFr(missing.map((capability) => CAPABILITY_OBJECTS[capability]))} ` +
                    `${ON_STORE[store]}.${need ? ` ${need}` : ''}`,
                known: true
            }
        ];
    });

    if (lines.length === 0) return null;
    return (
        <div className={styles.capability} role='status'>
            {lines.map((line) => (
                <p key={line.store}>{line.text}</p>
            ))}
            {lines.some((line) => line.known) && (
                <FeatureSettingsButton
                    scope={{ kind: 'feature', feature: 'appstores' }}
                    initialSection='sources'
                    variant='link'
                    label='Voir les comptes de store'
                />
            )}
        </div>
    );
}

export default CapabilityNote;
