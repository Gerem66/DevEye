import { useEffect, useState } from 'react';
import { ws } from '@/api/ws';
import { acquireMetrics } from '@/stores/metricsSubscription';
import Button from '@/Components/Button';
import { DEVICE_POWER_EVENT, type AgentPowerAction, type DevicePowerPush } from 'deveye-types';
import styles from './Monitoring.module.css';

interface PowerActionDef {
    action: AgentPowerAction;
    label: string;
    desc: string;
    icon: string;
    /** Disruptive actions (power state lost / device unreachable) require a confirmation. */
    confirm: boolean;
    /** Renders the confirm button in the danger tone (power-off / reboot). */
    danger?: boolean;
}

/** Ordered least → most disruptive, so the riskiest sit at the bottom. */
const ACTIONS: PowerActionDef[] = [
    {
        action: 'lock',
        label: 'Verrouiller',
        desc: 'Verrouille la session — la machine continue de tourner.',
        icon: 'icon-lock',
        confirm: false
    },
    {
        action: 'suspend',
        label: 'Mettre en veille',
        desc: 'Suspension en RAM. L’appareil sera injoignable jusqu’à son réveil.',
        icon: 'icon-moon',
        confirm: true
    },
    {
        action: 'hibernate',
        label: 'Veille prolongée',
        desc: 'Suspension sur disque. Injoignable jusqu’au réveil (indisponible sur certains hôtes).',
        icon: 'icon-snowflake',
        confirm: true
    },
    {
        action: 'reboot',
        label: 'Redémarrer',
        desc: 'Redémarrage immédiat de la machine.',
        icon: 'icon-restart',
        confirm: true,
        danger: true
    },
    {
        action: 'shutdown',
        label: 'Éteindre',
        desc: 'Extinction immédiate. L’appareil restera hors ligne jusqu’à un rallumage manuel.',
        icon: 'icon-power',
        confirm: true,
        danger: true
    }
];

interface ResultState {
    action: AgentPowerAction;
    ok: boolean;
    error?: string;
}

/**
 * System power-action menu for one device. Lists the available actions, requires
 * an explicit confirmation for the disruptive ones (no Enter-to-fire — accidental
 * key presses must never power off a machine), and surfaces the live outcome
 * pushed back by the agent (`device.powerResult`).
 */
export function PowerMenu({ deviceId }: { deviceId: string }) {
    // Which action is awaiting confirmation, the one in flight, and the last outcome.
    const [armed, setArmed] = useState<PowerActionDef | null>(null);
    const [sending, setSending] = useState<AgentPowerAction | null>(null);
    const [result, setResult] = useState<ResultState | null>(null);

    // Ref-counted live subscription so the result push reaches us (released on unmount).
    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    useEffect(() => {
        const off = ws.onMessage((msg) => {
            if (msg.command === DEVICE_POWER_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DevicePowerPush;
                if (d.deviceId === deviceId) {
                    setResult({ action: d.action, ok: d.ok, error: d.error });
                    setSending((cur) => (cur === d.action ? null : cur));
                }
            }
        });
        return off;
    }, [deviceId]);

    const fire = (def: PowerActionDef) => {
        setArmed(null);
        setResult(null);
        setSending(def.action);
        ws.send('device.power', { deviceId, action: def.action }).catch((e) => {
            setResult({ action: def.action, ok: false, error: e instanceof Error ? e.message : 'Échec' });
            setSending(null);
        });
    };

    const onPick = (def: PowerActionDef) => {
        if (def.confirm) setArmed(def);
        else fire(def);
    };

    const busy = sending !== null;

    return (
        <div className={styles.powerMenu}>
            <div className={styles.powerList}>
                {ACTIONS.map((def) => {
                    const inFlight = sending === def.action;
                    return (
                        <button
                            key={def.action}
                            type='button'
                            className={`${styles.powerRow} ${def.danger ? styles.powerRowDanger : ''}`}
                            onClick={() => onPick(def)}
                            disabled={busy}
                        >
                            <span
                                className={`icon ${inFlight ? 'icon-spinner ' + styles.spinning : def.icon} ${styles.powerIcon}`}
                            />
                            <span className={styles.powerText}>
                                <span className={styles.powerLabel}>{def.label}</span>
                                <span className={styles.powerDesc}>{def.desc}</span>
                            </span>
                        </button>
                    );
                })}
            </div>

            {armed && (
                <div className={styles.powerConfirm}>
                    <span className={styles.powerConfirmText}>
                        Confirmer : <strong>{armed.label.toLowerCase()}</strong> de cet appareil ?
                    </span>
                    <div className={styles.powerConfirmActions}>
                        <Button variant='secondary' onClick={() => setArmed(null)}>
                            Annuler
                        </Button>
                        <Button variant={armed.danger ? 'danger' : 'primary'} onClick={() => fire(armed)}>
                            Confirmer
                        </Button>
                    </div>
                </div>
            )}

            {result && (
                <p className={result.ok ? styles.powerOk : styles.powerErr}>
                    {result.ok
                        ? `Commande « ${labelOf(result.action)} » exécutée sur l’appareil.`
                        : `Échec — ${result.error ?? 'erreur inconnue'}`}
                </p>
            )}
            {busy && !result && <p className={styles.powerHint}>Commande envoyée à l’agent…</p>}
        </div>
    );
}

function labelOf(action: AgentPowerAction): string {
    return ACTIONS.find((a) => a.action === action)?.label ?? action;
}
