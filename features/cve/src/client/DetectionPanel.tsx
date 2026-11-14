import { useEffect, useState } from 'react';
import {
    ErrorNote,
    errorNote,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    SegmentedControl,
    settingsStyles as shell,
    Switch,
    useResource,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import type { AlertThreshold, ExposurePrefs } from '../contracts/exposure';

import { api } from './api';
import styles from './style.module.css';

const THRESHOLDS: readonly { value: AlertThreshold; label: string }[] = [
    { value: 'critical', label: 'Critique' },
    { value: 'high', label: 'Élevée' },
    { value: 'medium', label: 'Moyenne' },
    { value: 'all', label: 'Toutes' }
];

/** Ce que la veille envoie sur les canaux de l'espace : chaque genre d'alerte se coupe à part. */
export default function DetectionPanel({ canWrite }: SettingsPanelProps) {
    const { data, error: loadError } = useResource(
        'cve.exposurePrefs',
        () => api.send('cve.exposurePrefs', {}),
        'Les réglages sont injoignables.'
    );
    const [prefs, setPrefs] = useState<ExposurePrefs | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    useEffect(() => {
        if (data) setPrefs(data.prefs);
    }, [data]);

    if (!prefs) {
        return loadError ? <ErrorNote note={loadError} /> : <p className={styles.empty}>Chargement…</p>;
    }
    const alert = (key: keyof ExposurePrefs['alerts'], on: boolean): void =>
        setPrefs({ ...prefs, alerts: { ...prefs.alerts, [key]: on } });

    const save = async (): Promise<void> => {
        setError(null);
        try {
            await api.send('cve.setExposurePrefs', { prefs });
            invalidate('cve.exposurePrefs');
        } catch (e) {
            setError(errorNote(e, 'Les réglages n’ont pas pu être enregistrés.'));
            throw e;
        }
    };

    return (
        <div className={shell.section}>
            <span className={shell.sectionLabel}>Alertes</span>
            <p className={shell.sectionHint}>
                Ce qui part sur les canaux de l’onglet Notifications. Une alerte par faille, qui nomme les éléments
                touchés ; ce que trouve la première lecture d’un élément arrive en un seul récapitulatif.
            </p>
            <Switch
                checked={prefs.alerts.vuln}
                onChange={(on) => alert('vuln', on)}
                label='Nouvelle faille'
                hint='Une faille publiée qui touche ce que l’espace fait tourner, ou un élément qui se met à employer une version touchée.'
                disabled={!canWrite}
            />
            {prefs.alerts.vuln && (
                <div className={styles.subSetting}>
                    <span className={styles.subSettingLabel}>À partir de la gravité</span>
                    <SegmentedControl
                        options={THRESHOLDS}
                        value={prefs.threshold}
                        onChange={(threshold) => setPrefs({ ...prefs, threshold })}
                        aria-label='Gravité à partir de laquelle une faille envoie une alerte'
                        disabled={!canWrite}
                    />
                </div>
            )}
            <Switch
                checked={prefs.alerts.deprecated}
                onChange={(on) => alert('deprecated', on)}
                label='Paquet déprécié ou abandonné'
                hint='Un paquet que son auteur a déprécié, ou que son registre signale comme plus maintenu.'
                disabled={!canWrite}
            />

            {canWrite ? (
                <SaveButton onSave={save} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur la veille CVE.
                </ReadOnlyNotice>
            )}
            <ErrorNote note={error} />
        </div>
    );
}
