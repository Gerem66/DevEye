import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { acquireMetrics, Button, FeatureSettingsButton, onServerEvent } from 'deveye-sdk-client';
import {
    DEVICE_TERM_EXIT_EVENT,
    DEVICE_TERM_OUTPUT_EVENT,
    deviceTermExitPushSchema,
    deviceTermOutputPushSchema,
    terminalUser
} from '@deveye/types';

import { agent } from './api';
import { currentDevices, useDevices } from './store';
import styles from './style.module.css';

/**
 * Les réglages du terminal portés par l'appareil, lus à l'instant où on en a
 * besoin : ils vivent dans la liste de l'espace, qui se rafraîchit en direct.
 */
function terminalPrefs(deviceId: string): { user: string | undefined; closeOnExit: boolean } {
    const device = currentDevices().find((d) => d.id === deviceId);
    const u = device?.terminalDefaultUser ?? '';
    return {
        user: u && terminalUser.safeParse(u).success ? u : undefined,
        closeOnExit: device?.terminalCloseOnExit ?? true
    };
}

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

/** Les couleurs du terminal, prises au thème (`--terminal-*`, sombres dans les deux). */
function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string) => cs.getPropertyValue(name).trim();
    return {
        background: v('--terminal-bg'),
        foreground: v('--terminal-fg'),
        cursor: v('--terminal-cursor'),
        selectionBackground: v('--terminal-selection')
    };
}

/**
 * Interactive remote terminal for one device, backed by an agent-side PTY:
 * xterm.js bridged over the WS push channel, PTY sized to the viewport, session
 * closed on unmount. Keystrokes and output are base64 so raw bytes survive JSON.
 */
export function TerminalPanel({ deviceId, onClose }: { deviceId: string; onClose?: () => void }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const deviceName = useDevices().devices.find((d) => d.id === deviceId)?.name ?? 'Appareil';
    const [exited, setExited] = useState<{ code: number | null; error?: string } | null>(null);
    // Bumped to force a full remount of the effect (a fresh session) on "restart".
    const [generation, setGeneration] = useState(0);
    const relaunch = () => setGeneration((g) => g + 1);
    // In a ref so the session effect never re-runs on a parent re-render.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const sessionId = crypto.randomUUID();
        setExited(null);

        const term = new Terminal({
            cursorBlink: true,
            // The app's bundled Powerline-patched Meslo first (Styles/fonts.css), so
            // prompt separators render for every viewer; then any local Nerd Font.
            fontFamily:
                "'MesloLGS', 'MesloLGS NF', 'FiraCode Nerd Font', 'Hack Nerd Font', 'JetBrainsMono Nerd Font', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
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
            // xterm measures glyph-cell size eagerly: re-fit and repaint once the
            // bundled font is loaded, or the first paint looks misaligned.
            void document.fonts.load("13px 'MesloLGS'").then(() => {
                if (disposed) return;
                safeFit();
                term.refresh(0, term.rows - 1);
            });
            void agent
                .send('agent.termOpen', {
                    deviceId,
                    sessionId,
                    cols: term.cols,
                    rows: term.rows,
                    user: terminalPrefs(deviceId).user
                })
                .catch((e) => setExited({ code: null, error: e instanceof Error ? e.message : 'Échec' }));
        });

        // Keystrokes / paste → agent.
        const onData = term.onData((d) => {
            void agent
                .send('agent.termInput', { deviceId, sessionId, data: bytesToBase64(new TextEncoder().encode(d)) })
                .catch(() => {});
        });

        // Viewport changes → resize the PTY to match.
        const pushResize = () => {
            void agent
                .send('agent.termResize', { deviceId, sessionId, cols: term.cols, rows: term.rows })
                .catch(() => {});
        };
        const onResize = term.onResize(pushResize);
        const observer = new ResizeObserver(() => {
            safeFit();
        });
        observer.observe(container);

        // Agent → terminal: output + session end, filtered to this session.
        const offOutput = onServerEvent(DEVICE_TERM_OUTPUT_EVENT, deviceTermOutputPushSchema, (d) => {
            if (d.deviceId === deviceId && d.sessionId === sessionId) term.write(base64ToBytes(d.data));
        });
        const offExit = onServerEvent(DEVICE_TERM_EXIT_EVENT, deviceTermExitPushSchema, (d) => {
            if (d.deviceId !== deviceId || d.sessionId !== sessionId) return;
            // End of shell closes the popup, or keeps it open with the banner.
            if (terminalPrefs(deviceId).closeOnExit) onCloseRef.current?.();
            else setExited({ code: d.code ?? null, error: d.error });
        });

        return () => {
            disposed = true;
            offOutput();
            offExit();
            onData.dispose();
            onResize.dispose();
            observer.disconnect();
            void agent.send('agent.termClose', { deviceId, sessionId }).catch(() => {});
            term.dispose();
        };
    }, [deviceId, generation]);

    return (
        <div className={styles.terminalWrap}>
            {/* Les réglages vivent dans la coquille, à l'échelle de CET
                appareil ; relancer applique un nouveau compte. */}
            <div className={styles.terminalBar}>
                <Button variant='ghost' icon='refresh' onClick={relaunch} title='Relancer la session'>
                    Relancer la session
                </Button>
                <FeatureSettingsButton
                    scope={{ kind: 'item', feature: 'devices', itemId: deviceId, itemLabel: deviceName }}
                    variant='ghost'
                />
            </div>
            <div className={styles.terminalHost} ref={containerRef} />
            {exited && (
                <div className={styles.terminalExit}>
                    <span>
                        {exited.error
                            ? `Session terminée — ${exited.error}`
                            : `Session terminée${exited.code != null ? ` (code ${exited.code})` : ''}.`}
                    </span>
                    <div className={styles.terminalExitActions}>
                        <Button variant='secondary' onClick={relaunch}>
                            Relancer
                        </Button>
                        <Button variant='ghost' onClick={() => onCloseRef.current?.()}>
                            Fermer
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
