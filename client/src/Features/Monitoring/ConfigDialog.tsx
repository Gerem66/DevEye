import { useEffect, useState } from 'react';
import { ws } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import type { Device, ProcessCapture } from 'deveye-types';
import styles from './Monitoring.module.css';

const CUSTOM = '__custom__';

const METRIC_PRESETS = [10, 30, 60, 300]; // seconds
const RET_PRESETS = [7, 30, 90, 365]; // days
const PROC_PRESETS = [1, 3, 7, 30]; // days

// Mirrors the server defaults (see `src/agent/mappers.ts` + `Env`): one
// collection every 60 s, everything kept 30 days.
const DEFAULTS = { metricSec: 60, retentionDays: 30, procRetentionDays: 30 };

/**
 * Rough daily storage per device at a given cadence, so the cost of a fast
 * cadence is visible *before* saving. Based on the measured size of a gzipped
 * process list (~4.8 KB for ~580 programs); `top` carries ~20 entries instead.
 */
function estimateDailyBytes(intervalSec: number, capture: ProcessCapture): number {
    if (capture === 'off') return 0;
    const perSample = capture === 'top' ? 900 : 4800;
    return (86400 / intervalSec) * perSample;
}

function formatMb(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} Mo` : `${Math.round(bytes / 1024)} Ko`;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}

interface ConfigDialogProps {
    open: boolean;
    device: Device | null;
    onClose: () => void;
    /** Called after a successful save (parent refreshes the device list). */
    onSaved: () => void;
}

/**
 * Per-device collection settings, opened from the Monitoring panel. Every numeric
 * field is a quick-pick dropdown of sensible presets with a final "Personnalisé…"
 * option that reveals a styled free input.
 */
export function ConfigDialog({ open, device, onClose, onSaved }: ConfigDialogProps) {
    // Each numeric field = a select value (preset string or CUSTOM) + custom text.
    const [metricSel, setMetricSel] = useState('60');
    const [metricCustom, setMetricCustom] = useState('60');
    const [capture, setCapture] = useState<ProcessCapture>('all');
    const [retSel, setRetSel] = useState('30');
    const [retCustom, setRetCustom] = useState('30');
    const [procSel, setProcSel] = useState('1');
    const [procCustom, setProcCustom] = useState('1');
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // (Re)initialise from the device each time the dialog opens.
    useEffect(() => {
        if (!open || !device) return;
        const init = (presets: number[], v: number, setSel: (s: string) => void, setCustom: (s: string) => void) => {
            setSel(presets.includes(v) ? String(v) : CUSTOM);
            setCustom(String(v));
        };
        const metricSec = device.metricIntervalSeconds ?? DEFAULTS.metricSec;
        init(METRIC_PRESETS, metricSec, setMetricSel, setMetricCustom);
        init(RET_PRESETS, device.retentionDays ?? DEFAULTS.retentionDays, setRetSel, setRetCustom);
        init(PROC_PRESETS, device.processRetentionDays ?? DEFAULTS.procRetentionDays, setProcSel, setProcCustom);
        setCapture(device.processCapture ?? 'all');
        setError(null);
        // Re-init only when the dialog opens or the *selected device* changes —
        // not on every device-list poll (which replaces the object reference and
        // would wipe an in-progress "Personnalisé…" entry).
    }, [open, device?.id]);

    // Cadence currently selected, for the live storage estimate below.
    const estimateSec = Number(metricSel === CUSTOM ? metricCustom : metricSel) || DEFAULTS.metricSec;

    const resolve = (sel: string, custom: string): number | null => {
        const raw = sel === CUSTOM ? Number(custom) : Number(sel);
        return Number.isFinite(raw) && raw > 0 ? raw : null;
    };

    const save = async () => {
        if (!device) return;
        const metricSec = resolve(metricSel, metricCustom);
        const retentionDays = resolve(retSel, retCustom);
        const procRetentionDays = resolve(procSel, procCustom);
        if (metricSec === null || retentionDays === null || procRetentionDays === null) {
            setError('Une valeur personnalisée est invalide.');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await ws.send('device.setConfig', {
                deviceId: device.id,
                metricIntervalSeconds: clamp(Math.round(metricSec), 5, 3600),
                processCapture: capture,
                retentionDays: clamp(Math.round(retentionDays), 1, 3650),
                processRetentionDays: clamp(Math.round(procRetentionDays), 1, 3650)
            });
            onSaved();
            onClose();
        } catch (e) {
            // Surface the real reason rather than a generic message.
            setError(e instanceof Error ? e.message : 'Enregistrement impossible.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={device ? `Configuration — ${device.name}` : 'Configuration'}
            description='Cadence de collecte et durées de conservation. Chaque relevé enregistre les métriques et les processus au même instant. Appliqué dès le prochain relevé, que l’agent soit connecté ou non.'
            onSubmit={() => void save()}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose}>
                        Annuler
                    </Button>
                    <Button onClick={save} disabled={saving}>
                        {saving ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </>
            }
        >
            <div className={styles.configGrid}>
                <ConfigChoice
                    label='Intervalle de collecte'
                    unit='s'
                    presets={METRIC_PRESETS.map((v) => ({
                        value: v,
                        label: v >= 60 ? `${v / 60} min` : `${v} s`
                    }))}
                    sel={metricSel}
                    custom={metricCustom}
                    onSel={setMetricSel}
                    onCustom={setMetricCustom}
                />
                <label className={styles.configRow}>
                    <span className={styles.configLabel}>Processus capturés</span>
                    <div className={styles.configField}>
                        <SelectInput
                            value={capture}
                            onChange={(e) => setCapture(e.target.value as ProcessCapture)}
                            aria-label='Processus capturés'
                        >
                            <option value='all'>Tous</option>
                            <option value='top'>Top 20 (CPU + mémoire)</option>
                            <option value='off'>Désactivé</option>
                        </SelectInput>
                        <span className={styles.configHint}>
                            {capture === 'off'
                                ? 'Aucun historique de processus enregistré.'
                                : `≈ ${formatMb(estimateDailyBytes(estimateSec, capture))} par jour et par appareil.`}
                        </span>
                    </div>
                </label>
                <ConfigChoice
                    label='Conservation des données'
                    unit='j'
                    presets={RET_PRESETS.map((v) => ({ value: v, label: v === 365 ? '1 an' : `${v} j` }))}
                    sel={retSel}
                    custom={retCustom}
                    onSel={setRetSel}
                    onCustom={setRetCustom}
                />
                <ConfigChoice
                    label='Conservation des processus'
                    unit='j'
                    presets={PROC_PRESETS.map((v) => ({ value: v, label: `${v} j` }))}
                    sel={procSel}
                    custom={procCustom}
                    onSel={setProcSel}
                    onCustom={setProcCustom}
                />
            </div>
            {error && <p className={styles.configError}>{error}</p>}
        </Dialog>
    );
}

interface ConfigChoiceProps {
    label: string;
    unit: string;
    presets: { value: number; label: string }[];
    sel: string;
    custom: string;
    onSel: (s: string) => void;
    onCustom: (s: string) => void;
}

function ConfigChoice({ label, unit, presets, sel, custom, onSel, onCustom }: ConfigChoiceProps) {
    return (
        <label className={styles.configRow}>
            <span className={styles.configLabel}>{label}</span>
            <div className={styles.configField}>
                <SelectInput value={sel} onChange={(e) => onSel(e.target.value)} aria-label={label}>
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
                            onChange={(e) => onCustom(e.target.value)}
                            className={styles.configCustomInput}
                            aria-label={`${label} (valeur personnalisée)`}
                        />
                        <span className={styles.configUnit}>{unit}</span>
                    </span>
                )}
            </div>
        </label>
    );
}
