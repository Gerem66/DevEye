import { useState } from 'react';
import { Button, FeatureSettingsButton, StatusBadge } from 'deveye-sdk-client';

import { SENTINEL_RULES, type DeviceSentinelState, type RuleProbe } from '../contracts/domain';

import styles from './style.module.css';

/**
 * L'en-tête d'une machine : son état, ce qu'on sait mesurer d'elle, et les deux
 * actions qui la concernent.
 *
 * Les sondes manquantes sont **affichées** plutôt que tues. Une machine dont
 * l'agent ne remonte pas encore les chemins d'exécutables n'a pas « rien à se
 * reprocher » : elle n'a pas été regardée sur ce point, et la différence décide
 * s'il faut aller l'inspecter ou simplement mettre son agent à jour.
 *
 * Les réglages sont ceux de la coquille commune, ouverts sur l'onglet
 * Appareils (le même bouton que dans l'en-tête de la flotte) : plus de second
 * engrenage vers un dialogue maison.
 */

const PROBE_LABEL: Record<RuleProbe, string> = {
    snapshot: 'processus',
    report: 'rapport',
    execPath: 'chemins d’exécutables',
    posture: 'posture étendue',
    integrity: 'persistance',
    auth: 'authentification'
};

/** Ce qu'un agent complet remonte. L'écart avec `probes` est ce qu'on signale. */
const EXPECTED: RuleProbe[] = ['execPath', 'posture', 'integrity', 'auth'];

interface Props {
    device: DeviceSentinelState;
    /** Rend `true` si l'agent était joignable. */
    onScanNow: (deviceId: string) => Promise<boolean>;
}

export default function DeviceHeader({ device, onScanNow }: Props) {
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    const learningLeft =
        device.learningUntil === null ? null : Math.max(0, Math.ceil((device.learningUntil - Date.now()) / 86400000));
    const missing = EXPECTED.filter((p) => !device.probes.includes(p));

    async function scan(): Promise<void> {
        setBusy(true);
        setNotice(null);
        try {
            const requested = await onScanNow(device.deviceId);
            // « Pas demandé » n'est pas une erreur : l'agent est hors ligne, et le
            // dire vaut mieux qu'un échec silencieux ou qu'un faux succès.
            setNotice(
                requested
                    ? 'Relevé demandé : les résultats arrivent dans la minute.'
                    : 'Agent hors ligne : le relevé partira à sa prochaine connexion.'
            );
        } catch {
            setNotice("Le relevé n'a pas pu être demandé.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <header className={styles.header}>
            <div className={styles.headerTop}>
                <div className={styles.headerIdentity}>
                    <h2 className={styles.heading}>{device.deviceName}</h2>
                    <div className={styles.headerBadges}>
                        {!device.enabled ? (
                            <StatusBadge tone='neutral'>non surveillé</StatusBadge>
                        ) : device.learning ? (
                            <StatusBadge tone='accent'>
                                apprentissage, {learningLeft} j restant{(learningLeft ?? 0) > 1 ? 's' : ''}
                            </StatusBadge>
                        ) : (
                            <StatusBadge tone='success'>surveillé</StatusBadge>
                        )}
                        {device.enabled && device.lastIntegrityAt === null && (
                            <StatusBadge tone='warning' dot={false}>
                                persistance pas encore relevée
                            </StatusBadge>
                        )}
                    </div>
                </div>

                <div className={styles.headerActions}>
                    {device.enabled && (
                        <Button variant='secondary' icon='search' disabled={busy} onClick={() => void scan()}>
                            Relever maintenant
                        </Button>
                    )}
                    {/* Le bouton commun, en dernier, ouvert sur l'onglet Appareils :
                        une machine non surveillée l'affiche en primaire, avec le
                        seul geste qu'elle attend. */}
                    <FeatureSettingsButton
                        scope={{ kind: 'feature', feature: 'sentinel' }}
                        initialSection='devices'
                        variant={device.enabled ? 'ghost' : 'primary'}
                        label={device.enabled ? 'Réglages' : 'Activer la surveillance'}
                    />
                </div>
            </div>

            {device.enabled && device.learning && (
                <p className={styles.headerNote}>
                    Pendant l’apprentissage, Sentinelle observe sans rien reprocher : les écarts de comportement restent
                    muets. Les règles qui n’en dépendent pas (
                    {SENTINEL_RULES['exec.suspicious_path'].label.toLowerCase()}, posture, authentification) répondent
                    déjà.
                </p>
            )}

            {device.enabled && missing.length > 0 && (
                <p className={styles.headerNote}>
                    Non mesuré sur cette machine : {missing.map((p) => PROBE_LABEL[p]).join(', ')}. L’agent est
                    probablement antérieur à ces sondes : les règles correspondantes restent muettes plutôt que de
                    conclure à vide.
                </p>
            )}

            {notice && <p className={styles.notice}>{notice}</p>}
        </header>
    );
}
