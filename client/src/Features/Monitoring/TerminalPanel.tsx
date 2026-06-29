import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ws } from '@/api/ws';
import { acquireMetrics } from '@/stores/metricsSubscription';
import Button from '@/Components/Button';
import {
    DEVICE_TERM_EXIT_EVENT,
    DEVICE_TERM_OUTPUT_EVENT,
    type DeviceTermExitPush,
    type DeviceTermOutputPush
} from 'deveye-types';
import styles from './Monitoring.module.css';

/** base64 → bytes, for PTY output coming off the wire. */
function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** bytes → base64, for keystrokes going to the agent. */
function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

/** Pull a few theme colours so the terminal matches the current DA. */
function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
        background: v('--surface', '#0d1117'),
        foreground: v('--text-primary', '#e6edf3'),
        cursor: v('--accent', '#3ecf8e'),
        selectionBackground: v('--accent-bg', 'rgba(62, 207, 142, 0.3)')
    };
}

/**
 * Interactive remote terminal for one device, backed by an agent-side PTY. Opens a
 * session on mount, bridges xterm.js ⇄ the device over the WS push channel
 * (`device.termOutput` / `device.termExit`), keeps the PTY sized to the viewport,
 * and closes the session on unmount. Keystrokes and output are base64 so any raw
 * bytes survive the JSON transport.
 */
export function TerminalPanel({ deviceId }: { deviceId: string }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [exited, setExited] = useState<{ code: number | null; error?: string } | null>(null);
    // Bumped to force a full remount of the effect (a fresh session) on "restart".
    const [generation, setGeneration] = useState(0);

    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const sessionId = crypto.randomUUID();
        setExited(null);

        const term = new Terminal({
            cursorBlink: true,
            // Prefer a Nerd/Powerline font so oh-my-zsh / powerlevel10k prompt glyphs
            // (segment separators, icons) render instead of tofu boxes — MesloLGS NF
            // is the one p10k's wizard installs. Falls back to plain monospace.
            fontFamily:
                "'MesloLGS NF', 'MesloLGS Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'JetBrainsMono Nerd Font', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 13,
            scrollback: 5000,
            theme: themeColors()
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(container);

        let disposed = false;
        const safeFit = () => {
            try {
                fit.fit();
            } catch {
                /* container not laid out yet */
            }
        };

        // Open the PTY once the terminal has a size.
        requestAnimationFrame(() => {
            if (disposed) return;
            safeFit();
            term.focus();
            void ws
                .send('device.termOpen', { deviceId, sessionId, cols: term.cols, rows: term.rows })
                .catch((e) => setExited({ code: null, error: e instanceof Error ? e.message : 'Échec' }));
        });

        // Keystrokes / paste → agent.
        const onData = term.onData((d) => {
            void ws
                .send('device.termInput', { deviceId, sessionId, data: bytesToBase64(new TextEncoder().encode(d)) })
                .catch(() => {});
        });

        // Viewport changes → resize the PTY to match.
        const pushResize = () => {
            void ws
                .send('device.termResize', { deviceId, sessionId, cols: term.cols, rows: term.rows })
                .catch(() => {});
        };
        const onResize = term.onResize(pushResize);
        const observer = new ResizeObserver(() => {
            safeFit();
        });
        observer.observe(container);

        // Agent → terminal: output + session end, filtered to this session.
        const off = ws.onMessage((msg) => {
            if (msg.command === DEVICE_TERM_OUTPUT_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DeviceTermOutputPush;
                if (d.deviceId === deviceId && d.sessionId === sessionId) term.write(base64ToBytes(d.data));
            } else if (msg.command === DEVICE_TERM_EXIT_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DeviceTermExitPush;
                if (d.deviceId === deviceId && d.sessionId === sessionId) {
                    setExited({ code: d.code ?? null, error: d.error });
                }
            }
        });

        return () => {
            disposed = true;
            off();
            onData.dispose();
            onResize.dispose();
            observer.disconnect();
            void ws.send('device.termClose', { deviceId, sessionId }).catch(() => {});
            term.dispose();
        };
    }, [deviceId, generation]);

    return (
        <div className={styles.terminalWrap}>
            <div className={styles.terminalHost} ref={containerRef} />
            {exited && (
                <div className={styles.terminalExit}>
                    <span>
                        {exited.error
                            ? `Session terminée — ${exited.error}`
                            : `Session terminée${exited.code != null ? ` (code ${exited.code})` : ''}.`}
                    </span>
                    <Button variant='secondary' onClick={() => setGeneration((g) => g + 1)}>
                        Relancer
                    </Button>
                </div>
            )}
        </div>
    );
}
