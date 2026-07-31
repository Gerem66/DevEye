import { useRef, useState } from 'react';

import Button from '@/Components/Button';
import { DialogCancelButton } from '@/Components/Dialog';
import Popup, { ClosePopup } from '@/Components/Popup';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';

import styles from './style.module.css';

import {
    UPTIME_THRESHOLD_MAX,
    UPTIME_TIMEOUT_MAX,
    UPTIME_TIMEOUT_MIN,
    type UptimeMethod,
    type UptimeService
} from 'deveye-types';

export const SERVICE_POPUP = 'popup-uptime-service';

/** Keep a typed number inside its contract bounds (empty / NaN → `min`). */
function clamp(raw: string, min: number, max: number): number {
    return Math.min(max, Math.max(min, Number(raw) || min));
}

/** The service configuration a submit resolves with (`delete` on removal). */
export interface ServiceDraft {
    name: string;
    url: string;
    method: UptimeMethod;
    expectedStatus: number | null;
    keyword: string | null;
    intervalSeconds: number;
    timeoutSeconds: number;
    failureThreshold: number;
    retentionDays: number | null;
    notify: boolean;
    enabled: boolean;
}

export type ServicePopupResult = ServiceDraft | 'delete' | null;

/** Cadences offered, in seconds — from "nearly live" to a daily heartbeat. */
const INTERVALS: { value: number; label: string }[] = [
    { value: 30, label: '30 secondes' },
    { value: 60, label: '1 minute' },
    { value: 300, label: '5 minutes' },
    { value: 900, label: '15 minutes' },
    { value: 3600, label: '1 heure' },
    { value: 21600, label: '6 heures' },
    { value: 86400, label: '1 jour' }
];

/**
 * How long raw pings are kept. The daily summary is never pruned, so a shorter
 * retention only costs the per-ping detail — the uptime curve stays complete.
 */
const RETENTIONS: { value: number | null; label: string }[] = [
    { value: null, label: 'Tout garder (par défaut)' },
    { value: 7, label: '7 jours' },
    { value: 30, label: '30 jours' },
    { value: 90, label: '90 jours' },
    { value: 365, label: '1 an' },
    { value: 730, label: '2 ans' },
    { value: 1825, label: '5 ans' }
];

const DEFAULTS: ServiceDraft = {
    name: '',
    url: '',
    method: 'GET',
    expectedStatus: null,
    keyword: null,
    intervalSeconds: 60,
    timeoutSeconds: 10,
    failureThreshold: 2,
    retentionDays: null,
    notify: true,
    enabled: true
};

/** Add / edit form for one monitored service. Driven by `OpenPopup`. */
export function ServicePopup() {
    const [mode, setMode] = useState<'add' | 'edit'>('add');
    const [draft, setDraft] = useState<ServiceDraft>(DEFAULTS);
    const [errorName, setErrorName] = useState('');
    const [errorUrl, setErrorUrl] = useState('');
    // Snapshot of the values the popup opened with, to detect unsaved edits.
    const initial = useRef<ServiceDraft>(DEFAULTS);

    function set<K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]): void {
        setDraft((prev) => ({ ...prev, [key]: value }));
    }

    function handleOpen(input: UptimeService | null): void {
        const next: ServiceDraft = input
            ? {
                  name: input.name,
                  url: input.url,
                  method: input.method,
                  expectedStatus: input.expectedStatus,
                  keyword: input.keyword,
                  intervalSeconds: input.intervalSeconds,
                  timeoutSeconds: input.timeoutSeconds,
                  failureThreshold: input.failureThreshold,
                  retentionDays: input.retentionDays,
                  notify: input.notify,
                  enabled: input.enabled
              }
            : DEFAULTS;
        setMode(input ? 'edit' : 'add');
        setDraft(next);
        setErrorName('');
        setErrorUrl('');
        initial.current = next;
    }

    const dirty = (Object.keys(draft) as (keyof ServiceDraft)[]).some((k) => draft[k] !== initial.current[k]);

    function close(result: ServicePopupResult = null): void {
        ClosePopup(SERVICE_POPUP, result);
    }

    function submit(): void {
        const name = draft.name.trim();
        const url = draft.url.trim();
        // Mirrors the server contract (`z.string().url()`): reject here so the
        // user gets the message on the field rather than a generic WS error.
        const validUrl = /^https?:\/\/\S+$/i.test(url);
        if (!name || !validUrl) {
            setErrorName(name ? '' : 'Ce champ est obligatoire');
            setErrorUrl(validUrl ? '' : 'URL invalide (http:// ou https://)');
            return;
        }
        close({ ...draft, name, url, keyword: draft.keyword?.trim() || null });
    }

    return (
        <Popup
            id={SERVICE_POPUP}
            title={mode === 'add' ? 'Ajouter un service' : 'Modifier le service'}
            width={560}
            onInputChange={handleOpen}
            onClosePopup={() => close()}
            onSubmit={submit}
            dirty={dirty}
            onSave={submit}
        >
            <div className={styles.form}>
                <TextInput
                    placeholder='Nom (ex. API de production)'
                    value={draft.name}
                    error={errorName}
                    onChange={(e) => set('name', e.target.value)}
                />
                <TextInput
                    placeholder='https://exemple.com/health'
                    value={draft.url}
                    error={errorUrl}
                    onChange={(e) => set('url', e.target.value)}
                />

                <div className={styles.formRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Méthode</span>
                        <SelectInput
                            value={draft.method}
                            onChange={(e) => set('method', e.target.value as UptimeMethod)}
                        >
                            <option value='GET'>GET</option>
                            <option value='HEAD'>HEAD</option>
                            <option value='POST'>POST</option>
                        </SelectInput>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Statut attendu</span>
                        <TextInput
                            type='number'
                            min={100}
                            max={599}
                            placeholder='2xx / 3xx'
                            value={draft.expectedStatus ?? ''}
                            onChange={(e) =>
                                set('expectedStatus', e.target.value ? clamp(e.target.value, 100, 599) : null)
                            }
                        />
                    </label>
                </div>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Mot-clé attendu dans la réponse (optionnel)</span>
                    <TextInput
                        placeholder='ex. "ok"'
                        value={draft.keyword ?? ''}
                        onChange={(e) => set('keyword', e.target.value || null)}
                    />
                </label>

                <div className={styles.formRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Fréquence</span>
                        <SelectInput
                            value={draft.intervalSeconds}
                            onChange={(e) => set('intervalSeconds', Number(e.target.value))}
                        >
                            {INTERVALS.map((i) => (
                                <option key={i.value} value={i.value}>
                                    {i.label}
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Délai max (s)</span>
                        <TextInput
                            type='number'
                            min={UPTIME_TIMEOUT_MIN}
                            max={UPTIME_TIMEOUT_MAX}
                            value={draft.timeoutSeconds}
                            onChange={(e) =>
                                set('timeoutSeconds', clamp(e.target.value, UPTIME_TIMEOUT_MIN, UPTIME_TIMEOUT_MAX))
                            }
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Échecs avant alerte</span>
                        <TextInput
                            type='number'
                            min={1}
                            max={UPTIME_THRESHOLD_MAX}
                            value={draft.failureThreshold}
                            onChange={(e) => set('failureThreshold', clamp(e.target.value, 1, UPTIME_THRESHOLD_MAX))}
                        />
                    </label>
                </div>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Conservation de l’historique détaillé</span>
                    <SelectInput
                        value={draft.retentionDays === null ? '' : String(draft.retentionDays)}
                        onChange={(e) => set('retentionDays', e.target.value ? Number(e.target.value) : null)}
                    >
                        {RETENTIONS.map((r) => (
                            <option key={r.label} value={r.value === null ? '' : String(r.value)}>
                                {r.label}
                            </option>
                        ))}
                    </SelectInput>
                    <span className={styles.fieldHint}>
                        Le résumé journalier (disponibilité, latence) est conservé indéfiniment quoi qu’il arrive.
                    </span>
                </label>

                <label className={styles.check}>
                    <input type='checkbox' checked={draft.notify} onChange={(e) => set('notify', e.target.checked)} />
                    <span>M’alerter quand ce service tombe ou revient</span>
                </label>
                <label className={styles.check}>
                    <input type='checkbox' checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
                    <span>Surveillance active</span>
                </label>
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                    {mode === 'edit' && (
                        <Button variant='danger' onClick={() => close('delete')}>
                            Supprimer
                        </Button>
                    )}
                </div>
                <Button onClick={submit}>{mode === 'add' ? 'Ajouter' : 'Enregistrer'}</Button>
            </div>
        </Popup>
    );
}

export default ServicePopup;
