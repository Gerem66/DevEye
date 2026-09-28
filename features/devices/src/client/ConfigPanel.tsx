import { useEffect, useState, type ReactNode } from 'react';
import {
    humanizeError,
    ReadOnlyNotice,
    SaveButton,
    SelectInput,
    settingsStyles as shell,
    TextInput
} from 'deveye-sdk-client';
import { DEFAULT_PROCESS_CAPTURE, DEFAULT_RETENTION_DAYS, type Device, type ProcessCapture } from '@deveye/types';

import { api } from './api';
import { refreshDevices, useDevices } from './store';
import styles from './style.module.css';
import { formatInterval } from './utils';

const CUSTOM = '__custom__';
/** La cadence laissée à l'offre du propriétaire : `null` en base, suivie si l'offre change. */
const PLAN_DEFAULT = '__plan__';

const METRIC_PRESETS = [10, 30, 60, 300]; // seconds
const RET_PRESETS = [7, 30, 90, 365]; // days

/** Mesuré : une liste gzip d'environ 580 programmes, puis ses 20 premiers. */
const FULL_SAMPLE_BYTES = 4800;
const TOP_SAMPLE_BYTES = 900;
/** Le serveur réduit au top les listes complètes de plus de deux jours (`service.ts`). */
const FULL_LIST_DAYS = 2;

/**
 * Rough storage per device at a given cadence, visible before saving: what a
 * day costs, and what the whole retention holds once the lists older than two
 * days are cut down to their top.
 */
function estimateBytes(
    intervalSec: number,
    capture: ProcessCapture,
    days: number
): { daily: number; retained: number } {
    if (capture === 'off') return { daily: 0, retained: 0 };
    const samplesPerDay = 86400 / intervalSec;
    if (capture === 'top') {
        const daily = samplesPerDay * TOP_SAMPLE_BYTES;
        return { daily, retained: daily * days };
    }
    const fullDays = Math.min(days, FULL_LIST_DAYS);
    return {
        daily: samplesPerDay * FULL_SAMPLE_BYTES,
        retained: samplesPerDay * (fullDays * FULL_SAMPLE_BYTES + (days - fullDays) * TOP_SAMPLE_BYTES)
    };
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
    return `${Math.round(bytes / 1024)} Ko`;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}

/**
 * La configuration de collecte d'un appareil : le panneau Général de la
 * coquille de réglages à l'échelle d'un appareil. Autonome : il lit l'appareil
 * dans la liste de l'espace, se sauvegarde par `devices.setConfig` et relit la
 * liste après. Un appareil archivé ne collecte plus : lecture seule.
 */
export function ConfigPanel({ deviceId, canWrite }: { deviceId: string; canWrite: boolean }) {
    const { devices, loading } = useDevices();
    const device = devices.find((d) => d.id === deviceId) ?? null;
    const editable = canWrite && device !== null && device.status !== 'archived';

    // Each numeric field = a select value (preset string or CUSTOM) + custom text.
    const [metricSel, setMetricSel] = useState(PLAN_DEFAULT);
    const [metricCustom, setMetricCustom] = useState('');
    const [capture, setCapture] = useState<ProcessCapture>(DEFAULT_PROCESS_CAPTURE);
    const [retSel, setRetSel] = useState(String(DEFAULT_RETENTION_DAYS));
    const [retCustom, setRetCustom] = useState(String(DEFAULT_RETENTION_DAYS));
    const [error, setError] = useState<string | null>(null);

    // (Re)initialise only when the selected device changes: a list refresh
    // replaces the object reference and would wipe an in-progress entry.
    const known = device !== null;
    useEffect(() => {
        if (!device) return;
        const init = (presets: number[], v: number, setSel: (s: string) => void, setCustom: (s: string) => void) => {
            setSel(presets.includes(v) ? String(v) : CUSTOM);
            setCustom(String(v));
        };
        if (device.metricIntervalSeconds === null) {
            setMetricSel(PLAN_DEFAULT);
            setMetricCustom(String(device.effectiveMetricIntervalSeconds));
        } else {
            init(METRIC_PRESETS, device.metricIntervalSeconds, setMetricSel, setMetricCustom);
        }
        init(RET_PRESETS, device.retentionDays ?? DEFAULT_RETENTION_DAYS, setRetSel, setRetCustom);
        setCapture(device.processCapture ?? DEFAULT_PROCESS_CAPTURE);
        setError(null);
    }, [deviceId, known]);

    const resolve = (sel: string, custom: string): number | null => {
        const raw = sel === CUSTOM ? Number(custom) : Number(sel);
        return Number.isFinite(raw) && raw > 0 ? raw : null;
    };

    // Pour l'estimation vivante.
    const estimateSec =
        (metricSel === PLAN_DEFAULT ? null : resolve(metricSel, metricCustom)) ??
        device?.effectiveMetricIntervalSeconds ??
        60;
    const estimateDays = resolve(retSel, retCustom) ?? DEFAULT_RETENTION_DAYS;
    const estimate = estimateBytes(estimateSec, capture, estimateDays);

    const save = async (target: Device) => {
        const planDefault = metricSel === PLAN_DEFAULT;
        const metricSec = planDefault ? null : resolve(metricSel, metricCustom);
        const retentionDays = resolve(retSel, retCustom);
        if ((!planDefault && metricSec === null) || retentionDays === null) {
            setError('Une valeur personnalisée est invalide.');
            throw new Error('valeur invalide');
        }
        setError(null);
        try {
            await api.send('devices.setConfig', {
                deviceId: target.id,
                metricIntervalSeconds: metricSec === null ? null : clamp(Math.round(metricSec), 5, 3600),
                processCapture: capture,
                retentionDays: clamp(Math.round(retentionDays), 1, 3650)
            });
            await refreshDevices();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        }
    };

    if (!device) {
        return (
            <p className={loading ? shell.empty : shell.notice}>{loading ? 'Chargement…' : 'Appareil introuvable.'}</p>
        );
    }

    return (
        <div className={shell.section}>
            <p className={shell.sectionHint}>
                Chaque relevé enregistre les métriques et les processus au même instant, et les conserve aussi
                longtemps. Appliqué dès le prochain relevé, que l’agent soit connecté ou non.
            </p>
            {device.status === 'archived' && (
                <p className={shell.notice}>
                    Appareil archivé : son historique est figé, sa collecte ne se règle plus.
                </p>
            )}
            <div className={styles.configGrid}>
                <ConfigChoice
                    label='Intervalle de collecte'
                    unit='s'
                    planDefault={
                        device.metricIntervalSeconds === null
                            ? `Selon l’offre (${formatInterval(device.effectiveMetricIntervalSeconds)})`
                            : 'Selon l’offre'
                    }
                    presets={METRIC_PRESETS.map((v) => ({
                        value: v,
                        label: v >= 60 ? `${v / 60} min` : `${v} s`
                    }))}
                    sel={metricSel}
                    custom={metricCustom}
                    disabled={!editable}
                    onSel={setMetricSel}
                    onCustom={setMetricCustom}
                />
                <ConfigRow
                    label='Processus capturés'
                    hint={
                        capture === 'off'
                            ? 'Aucun historique de processus enregistré.'
                            : capture === 'all' && estimateDays > FULL_LIST_DAYS
                              ? `≈ ${formatBytes(estimate.daily)} par jour. Au-delà de deux jours, seul le top 20 d’un relevé est gardé : ~${formatBytes(estimate.retained)} conservés par appareil.`
                              : `≈ ${formatBytes(estimate.daily)} par jour, soit ~${formatBytes(estimate.retained)} conservés par appareil.`
                    }
                >
                    <SelectInput
                        value={capture}
                        disabled={!editable}
                        onChange={(e) => setCapture(e.target.value as ProcessCapture)}
                        aria-label='Processus capturés'
                    >
                        <option value='all'>Tous</option>
                        <option value='top'>Top 20 (CPU + mémoire)</option>
                        <option value='off'>Désactivé</option>
                    </SelectInput>
                </ConfigRow>
                <ConfigChoice
                    label='Conservation de l’historique'
                    unit='j'
                    presets={RET_PRESETS.map((v) => ({ value: v, label: v === 365 ? '1 an' : `${v} j` }))}
                    sel={retSel}
                    custom={retCustom}
                    disabled={!editable}
                    onSel={setRetSel}
                    onCustom={setRetCustom}
                />
            </div>
            {error && <p className={styles.configError}>{error}</p>}
            {editable && <SaveButton onSave={() => save(device)} />}
            {/* Le droit, jamais l'état : l'appareil archivé dit déjà pourquoi il
                est inerte, et le motif de rôle passe avant lui. */}
            {!canWrite && (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de régler la collecte d’un appareil : elle relève de l’écriture sur
                    Appareils.
                </ReadOnlyNotice>
            )}
        </div>
    );
}

/**
 * Une ligne du formulaire : libellé, champ, et une précision facultative sur
 * toute la largeur en dessous. La précision est un frère du champ, non son
 * enfant : dedans, elle se rangerait à côté du select et pousserait la ligne
 * hors du cadre.
 */
function ConfigRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
    return (
        <label className={styles.configRow}>
            <span className={styles.configLabel}>{label}</span>
            <div className={styles.configField}>{children}</div>
            {hint && <span className={styles.configHint}>{hint}</span>}
        </label>
    );
}

interface ConfigChoiceProps {
    label: string;
    unit: string;
    /** Le libellé de l'option qui s'en remet à l'offre, s'il y en a une. */
    planDefault?: string;
    presets: { value: number; label: string }[];
    sel: string;
    custom: string;
    disabled: boolean;
    onSel: (s: string) => void;
    onCustom: (s: string) => void;
}

function ConfigChoice({
    label,
    unit,
    planDefault,
    presets,
    sel,
    custom,
    disabled,
    onSel,
    onCustom
}: ConfigChoiceProps) {
    return (
        <ConfigRow label={label}>
            <SelectInput value={sel} disabled={disabled} onChange={(e) => onSel(e.target.value)} aria-label={label}>
                {planDefault && <option value={PLAN_DEFAULT}>{planDefault}</option>}
                {presets.map((p) => (
                    <option key={p.value} value={String(p.value)}>
                        {p.label}
                    </option>
                ))}
                <option value={CUSTOM}>Personnalisé…</option>
            </SelectInput>
            {sel === CUSTOM && (
                <span className={styles.configCustom}>
                    <TextInput
                        type='text'
                        inputMode='decimal'
                        value={custom}
                        disabled={disabled}
                        onChange={(e) => onCustom(e.target.value)}
                        className={styles.configCustomInput}
                        aria-label={`${label} (valeur personnalisée)`}
                    />
                    <span className={styles.configUnit}>{unit}</span>
                </span>
            )}
        </ConfigRow>
    );
}
