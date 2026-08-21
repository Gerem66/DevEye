import { featureDescriptor } from 'deveye-types';

import CredentialsPanel, { DEPLOY_CREDENTIALS, GIT_CREDENTIALS } from './CredentialsPanel';
import DestinationsSection from '@/Features/Backup/DestinationsSection';
import OsintKeysPanel from '@/Features/Osint/OsintKeysPanel';

import type { SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';

/**
 * Les **sources** de la fonctionnalité : ses réglages d'espace réutilisables,
 * que chaque élément ne fait que désigner.
 *
 * ## Le contrat, en trois temps
 *
 * 1. **Ici, à l'échelle de la fonctionnalité**, les sources se créent, se
 *    corrigent et se retirent. C'est le seul endroit : corriger une source
 *    corrige d'un coup tout ce qui s'en sert.
 * 2. **Dans le dialogue d'un élément**, on ne fait que **choisir** dans la
 *    liste : un sélecteur, jamais un formulaire de source.
 * 3. Le « + » à côté de ce sélecteur ouvre ces réglages-ci, directement sur cet
 *    onglet (`initialSection='sources'`), et l'élément adopte la source créée
 *    au retour.
 *
 * Les canaux de notification suivent le même contrat sans passer par ici : leur
 * gestion vit dans l'onglet Notifications à l'échelle de la fonctionnalité,
 * parce qu'un canal appartient à l'espace entier, pas à une fonctionnalité.
 *
 * ## Brancher une fonctionnalité de plus
 *
 * Une entrée `sources` dans `FEATURE_REGISTRY` (elle crée l'onglet et sa phrase
 * de tête), un panneau autonome (il se charge et se rafraîchit tout seul, la
 * coquille ne lui passe rien) et son cas dans l'aiguillage ci-dessous. Le
 * panneau vit chez sa feature (`Features/Backup/DestinationsSection`) ou dans
 * `Components` quand deux features le partagent (`CredentialsPanel`) ; dans les
 * deux cas il importe ses composants par chemins directs, jamais par le baril
 * `@/Components` : il réexporte cette coquille, ce serait un cycle.
 */
export default function SourcesSection({ scope }: { scope: SettingsScope }) {
    const descriptor = featureDescriptor(scope.feature);

    return (
        <div className={styles.section}>
            {descriptor.sources && <p className={styles.sectionHint}>{descriptor.sources.hint}</p>}
            {scope.feature === 'deploy' && <CredentialsPanel kind={DEPLOY_CREDENTIALS} />}
            {scope.feature === 'git' && <CredentialsPanel kind={GIT_CREDENTIALS} />}
            {scope.feature === 'backup' && <DestinationsSection />}
            {scope.feature === 'osint' && <OsintKeysPanel />}
        </div>
    );
}
