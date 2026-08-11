import { useState } from 'react';
import {
    DEFAULT_SENTINEL_INTEGRITY_MINUTES,
    DEFAULT_SENTINEL_LEARNING_DAYS,
    SENTINEL_INTEGRITY_MINUTES_MAX,
    SENTINEL_INTEGRITY_MINUTES_MIN,
    SENTINEL_LEARNING_DAYS_MAX,
    SENTINEL_LEARNING_DAYS_MIN,
    type DeviceSentinelState
} from 'deveye-types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';

import styles from './style.module.css';

/**
 * Les réglages d'une machine.
 *
 * Sentinelle est **éteinte par défaut**, appareil par appareil, et l'activer est
 * un geste explicite : c'est ce qui autorise la lecture des journaux
 * d'authentification, et cela ne doit pas arriver par simple effet de bord de
 * l'ouverture d'une feature.
 *
 * Le relevé d'authentification a son propre interrupteur, sous celui de la
 * feature : c'est la sonde la plus sensible, et vouloir la dérive de processus
 * sans vouloir les journaux d'auth est une position parfaitement raisonnable.
 */

interface Props {
    device: DeviceSentinelState;
    onChanged: (next: DeviceSentinelState) => void;
}

export default function SentinelSettings({ device, onChanged }: Props) {
    const [learningDays, setLearningDays] = useState(DEFAULT_SENTINEL_LEARNING_DAYS);
    const [integrityMinutes, setIntegrityMinutes] = useState(DEFAULT_SENTINEL_INTEGRITY_MINUTES);
    const [authEvents, setAuthEvents] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [scanned, setScanned] = useState<string | null>(null);

    async function apply(enabled: boolean): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            const res = await ws.send('sentinel.setConfig', {
                deviceId: device.deviceId,
                enabled,
                learningDays: enabled && !device.enabled ? learningDays : null,
                integrityMinutes,
                authEvents
            });
            onChanged(res.device);
        } catch {
            setError("Le réglage n'a pas pu être appliqué.");
        } finally {
            setBusy(false);
        }
    }

    async function scanNow(): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            const res = await ws.send('sentinel.scanNow', { deviceId: device.deviceId });
            // « Pas demandé » n'est pas une erreur : l'agent est simplement hors
            // ligne, et le dire clairement vaut mieux qu'un échec silencieux.
            setScanned(
                res.requested
                    ? 'Relevé demandé — les résultats arrivent dans la minute.'
                    : 'Agent hors ligne : le relevé partira à sa prochaine connexion.'
            );
        } catch {
            setError("Le relevé n'a pas pu être demandé.");
        } finally {
            setBusy(false);
        }
    }

    const learningLeft =
        device.learningUntil === null ? null : Math.max(0, Math.ceil((device.learningUntil - Date.now()) / 86400000));

    return (
        <div className={styles.settings}>
            <h3 className={styles.settingsTitle}>Surveillance de « {device.deviceName} »</h3>

            {device.enabled ? (
                <p className={styles.settingsState}>
                    {device.learning
                        ? `Apprentissage en cours — encore ${learningLeft} j. Les règles de dérive restent muettes ; les règles d’exécution, de posture et d’authentification sont déjà actives.`
                        : 'Surveillance active.'}
                </p>
            ) : (
                <p className={styles.settingsState}>
                    Sentinelle est éteinte sur cet appareil. Rien n’est relevé, et ses journaux ne sont pas lus.
                </p>
            )}

            {!device.enabled && (
                <label className={styles.field}>
                    Fenêtre d’apprentissage (jours)
                    <input
                        type='number'
                        className={styles.numberInput}
                        min={SENTINEL_LEARNING_DAYS_MIN}
                        max={SENTINEL_LEARNING_DAYS_MAX}
                        value={learningDays}
                        onChange={(e) => setLearningDays(Number(e.target.value))}
                    />
                    <span className={styles.fieldHint}>
                        Pendant cette période, tout ce qui tourne est absorbé comme normal. Sans elle, le premier jour
                        produirait des centaines de « nouveau programme ».
                    </span>
                </label>
            )}

            <label className={styles.field}>
                Relevé de persistance (minutes)
                <input
                    type='number'
                    className={styles.numberInput}
                    min={SENTINEL_INTEGRITY_MINUTES_MIN}
                    max={SENTINEL_INTEGRITY_MINUTES_MAX}
                    value={integrityMinutes}
                    onChange={(e) => setIntegrityMinutes(Number(e.target.value))}
                />
                <span className={styles.fieldHint}>
                    Empreinte cron, systemd, launchd, authorized_keys et les autres points d’installation au démarrage.
                    Seules les empreintes remontent, jamais le contenu des fichiers.
                </span>
            </label>

            <label className={styles.checkField}>
                <input type='checkbox' checked={authEvents} onChange={(e) => setAuthEvents(e.target.checked)} />
                <span>
                    Relever les issues d’authentification
                    <span className={styles.fieldHint}>
                        Échecs, réussites et leur origine, créations de compte. Des compteurs agrégés, pas un flux de
                        journal — l’activité des sessions n’est jamais remontée.
                    </span>
                </span>
            </label>

            {error && <p className={styles.error}>{error}</p>}
            {scanned && <p className={styles.notice}>{scanned}</p>}

            <div className={styles.actionRow}>
                <Button variant='primary' disabled={busy} onClick={() => void apply(!device.enabled)}>
                    {device.enabled ? 'Désactiver Sentinelle' : 'Activer Sentinelle'}
                </Button>
                {device.enabled && (
                    <>
                        <Button variant='secondary' disabled={busy} onClick={() => void apply(true)}>
                            Enregistrer les cadences
                        </Button>
                        <Button variant='ghost' icon='search' disabled={busy} onClick={() => void scanNow()}>
                            Relever maintenant
                        </Button>
                    </>
                )}
            </div>
        </div>
    );
}
