import { useCallback, useEffect, useState } from 'react';
import { Button, humanizeError, invalidate, SelectInput, settingsStyles as shell, TextInput } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import { UPTIME_THRESHOLD_MAX, UPTIME_TIMEOUT_MAX, UPTIME_TIMEOUT_MIN, type UptimeService } from '../contracts/domain';

import { api } from './api';
import { clamp, type ServiceTuning } from './format';

/** Cadences offered, in seconds: from "nearly live" to a daily heartbeat. */
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
 * retention only costs the per-ping detail: the uptime curve stays complete.
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

/** Keep a typed number inside its contract bounds (empty / NaN → `min`). */
function tuningOf(service: UptimeService): ServiceTuning {
    return {
        intervalSeconds: service.intervalSeconds,
        timeoutSeconds: service.timeoutSeconds,
        failureThreshold: service.failureThreshold,
        retentionDays: service.retentionDays
    };
}

/**
 * Le panneau Général d'un service : cadence de relève, délai, seuil de
 * défaillance et rétention. Autonome : il charge le service par `uptime.list`,
 * enregistre par `uptime.update` (qui prend le service entier, identité
 * conservée) et ravive `uptime.list`. Sans droit d'écriture, les champs restent
 * lisibles mais figés.
 */
export default function ServiceGeneralPanel({ scope, canWrite }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? scope.itemId : null;
    const [service, setService] = useState<UptimeService | null>(null);
    const [draft, setDraft] = useState<ServiceTuning | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (itemId === null) return;
        try {
            const res = await api.send('uptime.list', {});
            const found = res.services.find((s) => s.id === itemId) ?? null;
            setService(found);
            setDraft(found ? tuningOf(found) : null);
            if (!found) setError('Ce service n’existe plus.');
        } catch (e) {
            setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.'));
        }
    }, [itemId]);

    useEffect(() => {
        void load();
    }, [load]);

    const submit = async () => {
        if (busy || !service || !draft) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('uptime.update', {
                id: service.id,
                service: {
                    name: service.name,
                    url: service.url,
                    method: service.method,
                    expectedStatus: service.expectedStatus,
                    keyword: service.keyword,
                    enabled: service.enabled,
                    ...draft
                }
            });
            setService(res.service);
            setDraft(tuningOf(res.service));
            invalidate('uptime.list');
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    if (!draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const set = <K extends keyof ServiceTuning>(key: K, value: ServiceTuning[K]) =>
        setDraft((d) => (d ? { ...d, [key]: value } : d));

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Fréquence de relève</span>
                <SelectInput
                    value={draft.intervalSeconds}
                    disabled={!canWrite}
                    onChange={(e) => set('intervalSeconds', Number(e.target.value))}
                >
                    {INTERVALS.map((i) => (
                        <option key={i.value} value={i.value}>
                            {i.label}
                        </option>
                    ))}
                </SelectInput>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Délai maximum d’une sonde (secondes)</span>
                <TextInput
                    type='number'
                    min={UPTIME_TIMEOUT_MIN}
                    max={UPTIME_TIMEOUT_MAX}
                    value={draft.timeoutSeconds}
                    disabled={!canWrite}
                    onChange={(e) =>
                        set('timeoutSeconds', clamp(e.target.value, UPTIME_TIMEOUT_MIN, UPTIME_TIMEOUT_MAX))
                    }
                />
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Échecs consécutifs avant alerte</span>
                <TextInput
                    type='number'
                    min={1}
                    max={UPTIME_THRESHOLD_MAX}
                    value={draft.failureThreshold}
                    disabled={!canWrite}
                    onChange={(e) => set('failureThreshold', clamp(e.target.value, 1, UPTIME_THRESHOLD_MAX))}
                />
                <span className={shell.fieldHint}>
                    Un échec isolé ne fait pas une panne : le service ne bascule hors ligne qu’après ce nombre d’échecs
                    d’affilée.
                </span>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Conservation de l’historique détaillé</span>
                <SelectInput
                    value={draft.retentionDays === null ? '' : String(draft.retentionDays)}
                    disabled={!canWrite}
                    onChange={(e) => set('retentionDays', e.target.value ? Number(e.target.value) : null)}
                >
                    {RETENTIONS.map((r) => (
                        <option key={r.label} value={r.value === null ? '' : String(r.value)}>
                            {r.label}
                        </option>
                    ))}
                </SelectInput>
                <span className={shell.fieldHint}>
                    Le résumé journalier (disponibilité, latence) est conservé indéfiniment quoi qu’il arrive.
                </span>
            </div>

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <Button onClick={() => void submit()} disabled={busy}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </div>
            ) : (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur Uptime.
                </p>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
