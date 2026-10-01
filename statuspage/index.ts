import { readFileSync } from 'node:fs';

import { createMailer } from '../src/Services/mailer';
import { STATUS_CHANNELS_PATH, STATUS_TRACKING_PATH } from '../src/Services/statusProbeContract';
import { CHANNELS_REFRESH_MS, createAlerts } from './alerts';
import { env } from './env';
import { createMonitor } from './monitor';
import { REQUEST_TIMEOUT_MS, runProbe } from './probe';
import { createStatusServer } from './server';
import { openStore } from './store';
import { createTracking } from './tracking';
import { buildView } from './view';

/**
 * La page d'état publique de DevEye, dans son propre conteneur : elle mesure
 * l'app de l'extérieur, comme un visiteur, et reste debout quand l'app tombe.
 */

const store = openStore(env.dbPath);

/** Une lecture chez DevEye, sous le jeton de la sonde. */
async function askDevEye(path: string): Promise<unknown> {
    const response = await fetch(`${env.appUrl}${path}`, {
        headers: { authorization: `Bearer ${env.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

const alerts = createAlerts({
    store,
    live: env.environment === 'prod',
    origin: env.appUrl,
    mailer: createMailer(env.smtp),
    fallbackEmail: env.fallbackEmail,
    fetchChannels: () => askDevEye(STATUS_CHANNELS_PATH),
    post: async (url, body) => {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        await response.body?.cancel().catch(() => undefined);
        return response.ok;
    },
    log: (message) => console.warn(message)
});

const monitor = createMonitor({
    store,
    intervalSeconds: env.intervalSeconds,
    probe: () => runProbe({ appUrl: env.appUrl, publicUrl: env.publicUrl, token: env.token }),
    onChange: (change) => {
        const { component, transition } = change;
        console.info(
            `${component.label} : ${transition.from ?? 'inconnu'} → ${transition.to}${change.next.reason ? ` (${change.next.reason})` : ''}`
        );
        alerts.onChange(change);
    },
    warn: (message) => console.warn(message)
});

const tracking = createTracking({ store, fetchTracking: () => askDevEye(STATUS_TRACKING_PATH) });

const icon = readFileSync(new URL('../src/assets/deveye-icon.png', import.meta.url));

const server = createStatusServer({
    view: (featureId) =>
        buildView(
            {
                now: Math.floor(Date.now() / 1000),
                intervalSeconds: env.intervalSeconds,
                components: store.components(),
                daily: (id, fromDay) => store.daily(id, fromDay),
                incidents: (ids, since) => store.incidents(ids, since)
            },
            featureId
        ),
    render: { siteUrl: env.siteUrl, appUrl: env.appUrl },
    tracking: tracking.current,
    icon,
    lastTick: monitor.lastTick
});

let timer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;

/** Un passage après l'autre, jamais deux à la fois : un DevEye qui traîne ne fait pas s'empiler les mesures. */
async function loop(): Promise<void> {
    const started = Date.now();
    try {
        await monitor.tick();
    } catch (e) {
        console.error('Passage de mesure en échec', e);
    }
    if (stopping) return;
    timer = setTimeout(() => void loop(), Math.max(1000, env.intervalSeconds * 1000 - (Date.now() - started)));
}

/** Ce que la page relit chez DevEye hors mesure : les destinations des alertes et sa balise. */
function refreshFromDevEye(): void {
    void alerts.refreshChannels();
    void tracking.refresh();
}

const channelsTimer = setInterval(refreshFromDevEye, CHANNELS_REFRESH_MS);

server.listen(env.port, () => {
    const watched = env.publicUrl ? `${env.appUrl} et ${env.publicUrl}/api/health` : env.appUrl;
    console.info(`Page d’état à l’écoute sur le port ${env.port}, surveille ${watched}`);
    refreshFromDevEye();
    void loop();
});

function shutdown(): void {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    clearInterval(channelsTimer);
    server.close(() => {
        store.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
