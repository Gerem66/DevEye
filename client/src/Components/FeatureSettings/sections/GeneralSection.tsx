import type { FeatureId } from '@deveye/types';

import MailGeneralPanel from '@/Features/Mail/MailGeneralPanel';

import type { SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';

/**
 * Les réglages **généraux** d'une fonctionnalité : ce qui ne relève ni des
 * sources, ni des notifications, ni du partage, et qui vivait jusque-là dans
 * des dialogues artisanaux derrière des engrenages dépareillés.
 *
 * Même patron que `SourcesSection` : la table dit qui a un panneau et à
 * quelles échelles, le panneau est autonome (il se charge et se sauvegarde
 * tout seul), et il importe ses composants par chemins directs, jamais par le
 * baril `@/Components` (qui réexporte cette coquille : cycle).
 */
// Indexée en `FeatureId` : un module absent de la table lit simplement
// `undefined` — son onglet Général vient de son manifest, jamais d'ici.
export const GENERAL_WIRED: Partial<Record<FeatureId, { feature: boolean; item: boolean }>> = {
    // Mail : l'affichage des messages et les images approuvées valent pour
    // toute la fonctionnalité. L'onglet reste offert depuis les réglages d'un
    // compte, pour que le bouton en haut à droite porte tout d'un coup.
    mail: { feature: true, item: true }
};

export default function GeneralSection({ scope }: { scope: SettingsScope }) {
    return <div className={styles.section}>{scope.feature === 'mail' && <MailGeneralPanel />}</div>;
}
