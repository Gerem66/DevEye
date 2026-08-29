import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    Checkbox,
    humanizeError,
    SelectInput,
    settingsStyles as shell,
    StatusBadge,
    Switch,
    useResource
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { DEFAULT_SENTINEL_LEARNING_DAYS, type DeviceSentinelState } from '../contracts/domain';

import { api, refreshSentinelViews } from './api';
import { refreshSentinel } from './store';
import styles from './style.module.css';

/**
 * Les réglages, appareil par appareil : l'onglet Appareils de la coquille de
 * réglages (Sentinelle n'a pas d'éléments). Éteinte par défaut : c'est
 * l'activation qui autorise la lecture des journaux d'authentification.
 * Se charge sur `sentinel.overview` et se sauvegarde par `sentinel.setConfig`.
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

export default function SentinelDevicesPanel({ canWrite }: SettingsPanelProps) {
    const load = useCallback(async () => (await api.send('sentinel.overview', {})).devices, []);
    const { data, error, loading } = useResource('sentinel.overview', load, 'Chargement impossible.');
    const devices = data ?? [];

    if (loading && !data) return <p className={shell.empty}>Chargement…</p>;
    if (error) return <p className={shell.notice}>{error}</p>;
    if (devices.length === 0) return <p className={shell.empty}>Aucun appareil dans cet espace.</p>;

    return (
        <div className={shell.section}>
            <p className={shell.sectionHint}>
                Activer la surveillance autorise l’agent à relever ses surfaces de persistance et, si vous le laissez
                coché, ses journaux d’authentification. Les réglages s’appliquent à la prochaine connexion d’une machine
                hors ligne.
            </p>
            {devices.map((device) => (
                <DeviceRow key={device.deviceId} device={device} canWrite={canWrite} />
            ))}
        </div>
    );
}

/** Les cadrans d'une machine, tels que le formulaire les tient. */
interface Draft {
    learningDays: number;
    integrityMinutes: number;
    authEvents: boolean;
    pinEvidence: boolean;
}

function draftOf(device: DeviceSentinelState): Draft {
    return {
        learningDays: DEFAULT_SENTINEL_LEARNING_DAYS,
        integrityMinutes: device.integrityMinutes,
        authEvents: device.authEvents,
        pinEvidence: device.pinEvidence
    };
}

function DeviceRow({ device, canWrite }: { device: DeviceSentinelState; canWrite: boolean }) {
    const [draft, setDraft] = useState<Draft>(() => draftOf(device));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // Remis à l'état de l'appareil à chaque relecture : un formulaire qui garde
    // les valeurs d'avant l'enregistrement d'un collègue est un piège.
    useEffect(() => {
        setDraft(draftOf(device));
    }, [device]);

    const learningLeft =
        device.learningUntil === null ? null : Math.max(0, Math.ceil((device.learningUntil - Date.now()) / 86400000));

    async function apply(enabled: boolean): Promise<void> {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await api.send('sentinel.setConfig', {
                deviceId: device.deviceId,
                enabled,
                // La fenêtre ne se relance qu'à l'allumage : la repartir à chaque
                // passage ferait taire la dérive sept jours de plus.
                learningDays: enabled && !device.enabled ? draft.learningDays : null,
                integrityMinutes: draft.integrityMinutes,
                authEvents: draft.authEvents,
                pinEvidence: draft.pinEvidence
            });
            refreshSentinelViews();
            void refreshSentinel();
            setNotice(
                enabled === device.enabled
                    ? 'Réglages appliqués.'
                    : enabled
                      ? 'Surveillance activée : l’apprentissage commence.'
                      : 'Surveillance désactivée.'
            );
        } catch (e) {
            setError(humanizeError(e, "Le réglage n'a pas pu être appliqué."));
        } finally {
            setBusy(false);
        }
    }

    async function relearn(): Promise<void> {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await api.send('sentinel.resetBaseline', { deviceId: device.deviceId });
            refreshSentinelViews();
            setNotice('Ligne de base effacée : l’apprentissage redémarre.');
        } catch (e) {
            setError(humanizeError(e, 'La remise à zéro a échoué.'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className={styles.panelDevice}>
            <div className={styles.panelDeviceHead}>
                <span className={styles.panelDeviceName}>{device.deviceName}</span>
                {!device.enabled ? (
                    <StatusBadge tone='neutral'>non surveillé</StatusBadge>
                ) : device.learning ? (
                    <StatusBadge tone='accent'>
                        apprentissage, {learningLeft} j restant{(learningLeft ?? 0) > 1 ? 's' : ''}
                    </StatusBadge>
                ) : (
                    <StatusBadge tone='success'>surveillé</StatusBadge>
                )}
                <Switch
                    checked={device.enabled}
                    disabled={!canWrite || busy}
                    aria-label={`Surveiller « ${device.deviceName} »`}
                    className={styles.panelDeviceSwitch}
                    onChange={(next) => void apply(next)}
                />
            </div>

            {!device.enabled && (
                <div className={shell.field}>
                    <span className={shell.fieldLabel}>Fenêtre d’apprentissage à l’activation</span>
                    <SelectInput
                        value={String(draft.learningDays)}
                        disabled={!canWrite || busy}
                        onChange={(e) => setDraft((d) => ({ ...d, learningDays: Number(e.target.value) }))}
                    >
                        {LEARNING_PRESETS.map((d) => (
                            <option key={d} value={d}>
                                {d} jour{d > 1 ? 's' : ''}
                            </option>
                        ))}
                    </SelectInput>
                    <span className={shell.fieldHint}>
                        Pendant cette période, tout ce qui tourne est appris comme normal et les écarts restent muets.
                        Les règles d’exécution, de posture et d’authentification, elles, répondent immédiatement.
                    </span>
                </div>
            )}

            <div className={shell.field}>
                <span className={shell.fieldLabel}>Relevé de persistance</span>
                <SelectInput
                    value={String(draft.integrityMinutes)}
                    disabled={!canWrite || busy}
                    onChange={(e) => setDraft((d) => ({ ...d, integrityMinutes: Number(e.target.value) }))}
                >
                    {INTEGRITY_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                            {p.label}
                        </option>
                    ))}
                </SelectInput>
                <span className={shell.fieldHint}>
                    Empreinte cron, systemd, launchd, <code>authorized_keys</code> et les autres points d’installation
                    au démarrage. Seules les empreintes remontent, jamais le contenu des fichiers.
                </span>
            </div>

            <Checkbox
                checked={draft.authEvents}
                disabled={!canWrite || busy}
                onChange={(next) => setDraft((d) => ({ ...d, authEvents: next }))}
                className={styles.fieldCheck}
            >
                <span className={shell.fieldLabel}>Relever les issues d’authentification</span>
                <span className={shell.fieldHint}>
                    Échecs, réussites et leur origine, créations de compte. Des compteurs agrégés, pas un flux de
                    journal : l’activité des sessions n’est jamais remontée.
                </span>
            </Checkbox>

            <Checkbox
                checked={draft.pinEvidence}
                disabled={!canWrite || busy}
                onChange={(next) => setDraft((d) => ({ ...d, pinEvidence: next }))}
                className={styles.fieldCheck}
            >
                <span className={shell.fieldLabel}>Garder l’instant qui prouve un constat sérieux</span>
                <span className={shell.fieldHint}>
                    À l’ouverture d’un constat élevé ou critique, le relevé de processus correspondant est conservé et
                    apparaît dans l’historique de Monitoring, à l’abri de la rétention. Sans lui, le constat reste mais
                    ce qui l’explique disparaît au bout de quelques semaines.
                </span>
            </Checkbox>

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <Button onClick={() => void apply(device.enabled)} disabled={busy}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </div>
            ) : (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur Sentinelle.
                </p>
            )}

            {device.enabled && canWrite && (
                <div className={styles.dangerZone}>
                    <div className={styles.dangerText}>
                        <span className={shell.fieldLabel}>Réapprendre</span>
                        <span className={shell.fieldHint}>
                            Efface ce qui a été observé et relance une fenêtre d’apprentissage. À faire après une montée
                            de version de l’agent qui change ce qu’il mesure. Les décisions « légitime » sont conservées
                            : ce sont des choix, pas des observations.
                        </span>
                    </div>
                    <Button variant='secondary' icon='refresh' disabled={busy} onClick={() => void relearn()}>
                        Réapprendre
                    </Button>
                </div>
            )}

            {error && <p className={shell.notice}>{error}</p>}
            {notice && <p className={styles.notice}>{notice}</p>}
        </section>
    );
}
