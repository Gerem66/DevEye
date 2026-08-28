import { useEffect, useState, type ReactNode } from 'react';
import { ws } from '@/api/ws';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import {
    DEFAULT_METRIC_INTERVAL_SECONDS,
    DEFAULT_PROCESS_CAPTURE,
    DEFAULT_RETENTION_DAYS,
    type Device,
    type ProcessCapture
} from '@deveye/types';
import styles from './Monitoring.module.css';

const CUSTOM = '__custom__';

const METRIC_PRESETS = [10, 30, 60, 300]; // seconds
const RET_PRESETS = [7, 30, 90, 365]; // days

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

function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
    return `${Math.round(bytes / 1024)} Ko`;
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
    const [metricSel, setMetricSel] = useState(String(DEFAULT_METRIC_INTERVAL_SECONDS));
    const [metricCustom, setMetricCustom] = useState(String(DEFAULT_METRIC_INTERVAL_SECONDS));
    const [capture, setCapture] = useState<ProcessCapture>(DEFAULT_PROCESS_CAPTURE);
    const [retSel, setRetSel] = useState(String(DEFAULT_RETENTION_DAYS));
    const [retCustom, setRetCustom] = useState(String(DEFAULT_RETENTION_DAYS));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // (Re)initialise from the device each time the dialog opens.
    useEffect(() => {
        if (!open || !device) return;
        const init = (presets: number[], v: number, setSel: (s: string) => void, setCustom: (s: string) => void) => {
            setSel(presets.includes(v) ? String(v) : CUSTOM);
            setCustom(String(v));
        };
        init(
            METRIC_PRESETS,
            device.metricIntervalSeconds ?? DEFAULT_METRIC_INTERVAL_SECONDS,
            setMetricSel,
            setMetricCustom
        );
        init(RET_PRESETS, device.retentionDays ?? DEFAULT_RETENTION_DAYS, setRetSel, setRetCustom);
        setCapture(device.processCapture ?? DEFAULT_PROCESS_CAPTURE);
        setError(null);
        // Re-init only when the dialog opens or the *selected device* changes —
        // not on every device-list poll (which replaces the object reference and
        // would wipe an in-progress "Personnalisé…" entry).
    }, [open, device?.id]);

    const resolve = (sel: string, custom: string): number | null => {
        const raw = sel === CUSTOM ? Number(custom) : Number(sel);
        return Number.isFinite(raw) && raw > 0 ? raw : null;
    };

    // Cadence et conservation retenues, pour l'estimation vivante ci-dessous.
    const estimateSec = resolve(metricSel, metricCustom) ?? DEFAULT_METRIC_INTERVAL_SECONDS;
    const estimateDays = resolve(retSel, retCustom) ?? DEFAULT_RETENTION_DAYS;
    const dailyBytes = estimateDailyBytes(estimateSec, capture);

    const save = async () => {
        if (!device) return;
        const metricSec = resolve(metricSel, metricCustom);
        const retentionDays = resolve(retSel, retCustom);
        if (metricSec === null || retentionDays === null) {
            setError('Une valeur personnalisée est invalide.');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await ws.send('devices.setConfig', {
                deviceId: device.id,
                metricIntervalSeconds: clamp(Math.round(metricSec), 5, 3600),
                processCapture: capture,
                retentionDays: clamp(Math.round(retentionDays), 1, 3650)
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
            description='Cadence de collecte et durée de conservation. Chaque relevé enregistre les métriques et les processus au même instant, et les conserve aussi longtemps. Appliqué dès le prochain relevé, que l’agent soit connecté ou non.'
            // Plus large que le défaut : à 460 px, une ligne « libellé + select +
            // valeur personnalisée + unité » ne tenait pas et débordait.
            width={520}
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
                <ConfigRow
                    label='Processus capturés'
                    hint={
                        capture === 'off'
                            ? 'Aucun historique de processus enregistré.'
                            : `≈ ${formatBytes(dailyBytes)} par jour, soit ~${formatBytes(dailyBytes * estimateDays)} conservés par appareil.`
                    }
                >
                    <SelectInput
                        value={capture}
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
                    onSel={setRetSel}
                    onCustom={setRetCustom}
                />
            </div>
            {error && <p className={styles.configError}>{error}</p>}
        </Dialog>
    );
}

/**
 * Une ligne du formulaire : libellé à gauche, champ à droite, et une précision
 * facultative sur toute la largeur en dessous.
 *
 * Le complément est un **frère** du champ et non son enfant : posé dedans, il
 * devenait un élément de la rangée flex et se rangeait *à côté* du select au
 * lieu d'en dessous, poussant la ligne hors de la popup.
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
    presets: { value: number; label: string }[];
    sel: string;
    custom: string;
    onSel: (s: string) => void;
    onCustom: (s: string) => void;
}

function ConfigChoice({ label, unit, presets, sel, custom, onSel, onCustom }: ConfigChoiceProps) {
    return (
        <ConfigRow label={label}>
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
        </ConfigRow>
    );
}
