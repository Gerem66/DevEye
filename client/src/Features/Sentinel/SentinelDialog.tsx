import { useEffect, useState } from 'react';
import {
    DEFAULT_SENTINEL_INTEGRITY_MINUTES,
    DEFAULT_SENTINEL_LEARNING_DAYS,
    type DeviceSentinelState
} from 'deveye-types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';

import styles from './style.module.css';

/**
 * Les réglages d'une machine — un **dialogue**, pas un onglet.
 *
 * Un onglet est un endroit où l'on va lire ; des réglages sont une action qu'on
 * termine. Les mettre au même niveau que « Constats » et « Posture » obligeait à
 * les traverser pour atteindre ce qu'on cherchait, et faisait retomber dedans
 * chaque fois qu'on changeait de machine.
 *
 * Sentinelle est **éteinte par défaut**, appareil par appareil : c'est
 * l'activation qui autorise la lecture des journaux d'authentification, et cela
 * ne doit pas arriver par effet de bord de l'ouverture d'une feature.
 */

/** Fenêtres d'apprentissage proposées. La valeur libre n'apporterait rien ici. */
const LEARNING_PRESETS = [1, 3, 7, 14, 30];

/** Cadences de relevé de persistance, en minutes. */
const INTEGRITY_PRESETS = [
    { value: 60, label: 'toutes les heures' },
    { value: 180, label: 'toutes les 3 heures' },
    { value: 360, label: 'toutes les 6 heures' },
    { value: 720, label: 'deux fois par jour' },
    { value: 1440, label: 'une fois par jour' }
];

interface Props {
    open: boolean;
    device: DeviceSentinelState | null;
    onClose: () => void;
    /** Appelé après un enregistrement réussi, avec l'état renvoyé par le serveur. */
    onSaved: (next: DeviceSentinelState) => void;
    /** Remise à zéro de la ligne de base ; le parent recharge derrière. */
    onReset: (deviceId: string) => Promise<void>;
}

export function SentinelDialog({ open, device, onClose, onSaved, onReset }: Props) {
    const [learningDays, setLearningDays] = useState(DEFAULT_SENTINEL_LEARNING_DAYS);
    const [integrityMinutes, setIntegrityMinutes] = useState(DEFAULT_SENTINEL_INTEGRITY_MINUTES);
    const [authEvents, setAuthEvents] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // Remis à l'état de l'appareil à chaque ouverture : un dialogue qui garde les
    // valeurs de la machine précédente est un piège.
    useEffect(() => {
        if (!open) return;
        setLearningDays(DEFAULT_SENTINEL_LEARNING_DAYS);
        setIntegrityMinutes(DEFAULT_SENTINEL_INTEGRITY_MINUTES);
        setAuthEvents(true);
        setError(null);
        setNotice(null);
    }, [open, device?.deviceId]);

    if (!device) return null;

    async function apply(enabled: boolean): Promise<void> {
        if (!device) return;
        setBusy(true);
        setError(null);
        try {
            const res = await ws.send('sentinel.setConfig', {
                deviceId: device.deviceId,
                enabled,
                // La fenêtre ne se relance qu'à l'allumage : la repartir à chaque
                // passage dans les réglages ferait taire la dérive sept jours de
                // plus, sans que personne l'ait demandé.
                learningDays: enabled && !device.enabled ? learningDays : null,
                integrityMinutes,
                authEvents
            });
            onSaved(res.device);
            if (!enabled) onClose();
            else setNotice('Réglages appliqués.');
        } catch {
            setError("Le réglage n'a pas pu être appliqué.");
        } finally {
            setBusy(false);
        }
    }

    async function relearn(): Promise<void> {
        if (!device) return;
        setBusy(true);
        setError(null);
        try {
            await onReset(device.deviceId);
            setNotice('Ligne de base effacée — l’apprentissage redémarre.');
        } catch {
            setError('La remise à zéro a échoué.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={`Sentinelle — ${device.deviceName}`}
            description={
                device.enabled
                    ? 'Cette machine est surveillée. Les réglages s’appliquent à sa prochaine connexion si elle est hors ligne.'
                    : 'Activer la surveillance autorise l’agent à relever ses surfaces de persistance et, si vous le laissez coché, ses journaux d’authentification.'
            }
            width={560}
            footer={
                <div className={styles.dialogFooter}>
                    {device.enabled && (
                        <Button variant='ghost' disabled={busy} onClick={() => void apply(false)}>
                            Désactiver
                        </Button>
                    )}
                    <Button variant='primary' disabled={busy} onClick={() => void apply(true)}>
                        {device.enabled ? 'Enregistrer' : 'Activer la surveillance'}
                    </Button>
                </div>
            }
            onSubmit={() => void apply(true)}
        >
            <div className={styles.dialogBody}>
                {!device.enabled && (
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Fenêtre d’apprentissage</span>
                        <SelectInput
                            value={String(learningDays)}
                            onChange={(e) => setLearningDays(Number(e.target.value))}
                        >
                            {LEARNING_PRESETS.map((d) => (
                                <option key={d} value={d}>
                                    {d} jour{d > 1 ? 's' : ''}
                                </option>
                            ))}
                        </SelectInput>
                        <span className={styles.fieldHint}>
                            Pendant cette période, tout ce qui tourne est appris comme normal et les écarts restent
                            muets. Les règles d’exécution, de posture et d’authentification, elles, répondent
                            immédiatement.
                        </span>
                    </label>
                )}

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Relevé de persistance</span>
                    <SelectInput
                        value={String(integrityMinutes)}
                        onChange={(e) => setIntegrityMinutes(Number(e.target.value))}
                    >
                        {INTEGRITY_PRESETS.map((p) => (
                            <option key={p.value} value={p.value}>
                                {p.label}
                            </option>
                        ))}
                    </SelectInput>
                    <span className={styles.fieldHint}>
                        Empreinte cron, systemd, launchd, <code>authorized_keys</code> et les autres points
                        d’installation au démarrage. Seules les empreintes remontent, jamais le contenu des fichiers.
                    </span>
                </label>

                <Checkbox checked={authEvents} onChange={setAuthEvents} className={styles.fieldCheck}>
                    <span className={styles.fieldLabel}>Relever les issues d’authentification</span>
                    <span className={styles.fieldHint}>
                        Échecs, réussites et leur origine, créations de compte. Des compteurs agrégés, pas un flux de
                        journal : l’activité des sessions n’est jamais remontée.
                    </span>
                </Checkbox>

                {device.enabled && (
                    <div className={styles.dangerZone}>
                        <div>
                            <span className={styles.fieldLabel}>Réapprendre</span>
                            <span className={styles.fieldHint}>
                                Efface ce qui a été observé et relance une fenêtre d’apprentissage. À faire après une
                                montée de version de l’agent qui change ce qu’il mesure. Les décisions « légitime » sont
                                conservées : ce sont des choix, pas des observations.
                            </span>
                        </div>
                        <Button variant='secondary' icon='refresh' disabled={busy} onClick={() => void relearn()}>
                            Réapprendre
                        </Button>
                    </div>
                )}

                {error && <p className={styles.error}>{error}</p>}
                {notice && <p className={styles.notice}>{notice}</p>}
            </div>
        </Dialog>
    );
}

export default SentinelDialog;
