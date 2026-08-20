import { useEffect, useRef, useState } from 'react';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog, DialogCancelButton } from '@/Components/Dialog';
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

/** Everything the user sets on a service. */
interface ServiceDraft {
    name: string;
    url: string;
    method: UptimeMethod;
    expectedStatus: number | null;
    keyword: string | null;
    intervalSeconds: number;
    timeoutSeconds: number;
    failureThreshold: number;
    retentionDays: number | null;
    enabled: boolean;
}

interface ServiceDialogProps {
    open: boolean;
    /** Le service modifié, ou `null` pour un ajout. */
    service: UptimeService | null;
    onClose: () => void;
    onSaved: (service: UptimeService) => void;
    /** Absent = pas de suppression proposée (on ajoute depuis un projet). */
    onRemoved?: () => void;
}

/** Keep a typed number inside its contract bounds (empty / NaN → `min`). */
function clamp(raw: string, min: number, max: number): number {
    return Math.min(max, Math.max(min, Number(raw) || min));
}

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
    enabled: true
};

/**
 * Ajouter / régler un service surveillé.
 *
 * **Contrôlé, pas impérative.** Cette feature a longtemps vécu derrière
 * `OpenPopup`/`ClosePopup` — un registre global à clé unique, qu'un deuxième
 * montage écrase (`FeatureKeepAlive` en garde plusieurs à la fois vivants).
 * Cela suffisait tant que le formulaire n'ouvrait que depuis la feature Uptime
 * elle-même ; l'onglet Déploiement d'un projet doit désormais pouvoir déclarer
 * un service à la volée, exactement comme `TargetDialog` pour une cible de
 * déploiement — d'où ce même patron `open`/`service`/`onSaved`.
 */
export function ServiceDialog({ open, service, onClose, onSaved, onRemoved }: ServiceDialogProps) {
    const [draft, setDraft] = useState<ServiceDraft>(DEFAULTS);
    const [errorName, setErrorName] = useState('');
    const [errorUrl, setErrorUrl] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // Snapshot of the values the dialog opened with, to detect unsaved edits.
    const initial = useRef<ServiceDraft>(DEFAULTS);

    useEffect(() => {
        if (!open) return;
        const next: ServiceDraft = service
            ? {
                  name: service.name,
                  url: service.url,
                  method: service.method,
                  expectedStatus: service.expectedStatus,
                  keyword: service.keyword,
                  intervalSeconds: service.intervalSeconds,
                  timeoutSeconds: service.timeoutSeconds,
                  failureThreshold: service.failureThreshold,
                  retentionDays: service.retentionDays,
                  enabled: service.enabled
              }
            : DEFAULTS;
        setDraft(next);
        initial.current = next;
        setErrorName('');
        setErrorUrl('');
        setError(null);
    }, [open, service]);

    function set<K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]): void {
        setDraft((prev) => ({ ...prev, [key]: value }));
    }

    const dirty = (Object.keys(draft) as (keyof ServiceDraft)[]).some((k) => draft[k] !== initial.current[k]);

    const submit = async () => {
        if (busy) return;
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
        const payload = { ...draft, name, url, keyword: draft.keyword?.trim() || null };
        setBusy(true);
        setError(null);
        try {
            const res = service
                ? await ws.send('uptime.update', { id: service.id, service: payload })
                : await ws.send('uptime.add', { service: payload });
            onSaved(res.service);
        } catch {
            setError('Enregistrement impossible.');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!service || busy) return;
        setBusy(true);
        setError(null);
        try {
            await ws.send('uptime.remove', { id: service.id });
            onRemoved?.();
        } catch {
            setError('Suppression impossible.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={service ? 'Modifier le service' : 'Ajouter un service'}
            width={560}
            onSubmit={() => void submit()}
            dirty={dirty}
            onSave={() => void submit()}
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

                {/* « M'alerter quand ce service tombe » vivait ici, en doublon
                    muet de la section Notifications des réglages du service :
                    une route réglée pouvait rester silencieuse à cause d'une
                    case que rien ne signalait. Les canaux et le silence se
                    règlent désormais à un seul endroit : Réglages →
                    Notifications. */}
                <Checkbox checked={draft.enabled} onChange={(v) => set('enabled', v)}>
                    Surveillance active
                </Checkbox>

                {error && <p className={styles.error}>{error}</p>}
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                    {service && onRemoved && (
                        <Button variant='danger' onClick={() => void remove()} disabled={busy}>
                            Supprimer
                        </Button>
                    )}
                </div>
                <Button onClick={() => void submit()} disabled={busy}>
                    {busy ? 'Enregistrement…' : service ? 'Enregistrer' : 'Ajouter'}
                </Button>
            </div>
        </Dialog>
    );
}

export default ServiceDialog;
