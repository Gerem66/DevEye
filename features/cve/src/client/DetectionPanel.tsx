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
    const source = (key: keyof ExposurePrefs['sources'], on: boolean): void =>
        setPrefs({ ...prefs, sources: { ...prefs.sources, [key]: on } });

    const save = async (): Promise<void> => {
        setError(null);
        try {
            await api.send('cve.setExposurePrefs', { prefs });
            invalidate('cve.exposurePrefs', 'cve.exposure', 'cve.exposureCount', 'cve.inventory');
        } catch (e) {
            setError(errorNote(e, 'Les réglages n’ont pas pu être enregistrés.'));
            throw e;
        }
    };

    return (
        <div className={shell.section}>
            <span className={shell.sectionLabel}>Ce que la veille lit</span>
            <p className={shell.sectionHint}>
                Une source coupée n’est plus lue, et ce qu’elle avait trouvé ne compte plus nulle part.
            </p>
            <Switch
                checked={prefs.sources.git}
                onChange={(on) => source('git', on)}
                label='Dépôts Git'
                hint='Les verrous, Dockerfile, fichiers compose et versions épinglées de chaque dépôt, lus sans clone.'
                disabled={!canWrite}
            />
            <Switch
                checked={prefs.sources.device}
                onChange={(on) => source('device', on)}
                label='Appareils et conteneurs'
                hint='Le système de chaque appareil, son moteur Docker ou Podman, et l’image de chaque conteneur, par l’agent.'
                disabled={!canWrite}
            />
            <Switch
                checked={prefs.sources.database}
                onChange={(on) => source('database', on)}
                label='Bases de données'
                hint='La version du serveur de chaque base, telle que son dernier relevé l’a vue.'
                disabled={!canWrite}
            />
            <Switch
                checked={prefs.sources.deploy}
                onChange={(on) => source('deploy', on)}
                label='Déploiements Dokploy'
                hint='L’image d’une application de source Docker, et le fichier d’un compose, demandés à Dokploy.'
                disabled={!canWrite}
            />

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
