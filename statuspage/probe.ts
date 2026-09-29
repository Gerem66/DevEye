import { STATUS_PROBE_PATH, statusProbeSchema, type StatusProbe } from '../src/Services/statusProbeContract';
import type { Observation } from './state';

/**
 * Un passage : ce qu'un visiteur verrait de DevEye à cet instant. L'app par sa
 * page d'accueil et son API, la surface publique par sa santé, chaque module
 * par le relevé que DevEye donne de lui-même.
 */

export const REQUEST_TIMEOUT_MS = 10_000;

export interface ProbeTargets {
    appUrl: string;
    publicUrl: string | null;
    token: string;
}

export interface ProbeResult {
    app: Observation;
    public: Observation | null;
    /** `null` quand DevEye n'a pas donné son relevé : ses modules ne sont pas mesurés ce tour-ci. */
    features: StatusProbe['features'] | null;
    version: string | null;
    /** Le jeton refusé : une erreur de configuration, dite dans le journal, jamais une panne. */
    refused: boolean;
}

type Fetch = typeof fetch;

type Outcome = { ok: true; response: Response } | { ok: false; reason: string };

async function request(fetcher: Fetch, url: string, init: RequestInit = {}): Promise<Outcome> {
    try {
        const response = await fetcher(url, {
            ...init,
            redirect: 'manual',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { 'user-agent': 'DevEye-Statut/1.0', ...(init.headers ?? {}) }
        });
        return { ok: true, response };
    } catch (e) {
        const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        return { ok: false, reason: timeout ? 'Ne répond pas' : 'Injoignable' };
    }
}

const serverError = (status: number): string => `Erreur du serveur (${status})`;

async function drain(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
}

/** L'accueil de l'app : un document HTML, sinon le visiteur ne voit rien. */
async function probeRoot(fetcher: Fetch, appUrl: string): Promise<string | null> {
    const got = await request(fetcher, `${appUrl}/`);
    if (!got.ok) return got.reason;
    await drain(got.response);
    if (got.response.status !== 200) return serverError(got.response.status);
    const type = got.response.headers.get('content-type') ?? '';
    return type.includes('text/html') ? null : 'Application inaccessible';
}

type ProbeOutcome = { kind: 'ok'; probe: StatusProbe } | { kind: 'refused' } | { kind: 'failed'; reason: string };

async function probeApi(fetcher: Fetch, targets: ProbeTargets): Promise<ProbeOutcome> {
    const got = await request(fetcher, `${targets.appUrl}${STATUS_PROBE_PATH}`, {
        headers: { authorization: `Bearer ${targets.token}` }
    });
    if (!got.ok) return { kind: 'failed', reason: got.reason };
    const { response } = got;
    if (response.status === 401 || response.status === 404) {
        await drain(response);
        return { kind: 'refused' };
    }
    if (!response.ok) {
        await drain(response);
        return { kind: 'failed', reason: serverError(response.status) };
    }
    const parsed = statusProbeSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { kind: 'ok', probe: parsed.data } : { kind: 'failed', reason: 'Réponse illisible' };
}

async function probePublic(fetcher: Fetch, publicUrl: string): Promise<Observation> {
    const got = await request(fetcher, `${publicUrl}/api/health`);
    if (!got.ok) return { state: 'down', reason: got.reason, message: null };
    await drain(got.response);
    return got.response.ok
        ? { state: 'up', reason: null, message: null }
        : { state: 'down', reason: serverError(got.response.status), message: null };
}

/** L'état de l'app d'après ses deux réponses : l'une sans l'autre, un visiteur ne peut rien faire. */
export function appObservation(rootError: string | null, api: ProbeOutcome): Observation {
    if (api.kind === 'failed') return { state: 'down', reason: api.reason, message: null };
    if (rootError !== null) return { state: 'down', reason: rootError, message: null };
    if (api.kind === 'refused') return { state: 'up', reason: null, message: null };
    const { probe } = api;
    if (!probe.database) return { state: 'down', reason: 'Base de données injoignable', message: null };
    if (probe.site.state === 'maintenance') return { state: 'maintenance', reason: null, message: probe.site.message };
    if (probe.site.state === 'degraded') {
        return { state: 'degraded', reason: 'Forte affluence : priorité aux abonnés', message: null };
    }
    return { state: 'up', reason: null, message: null };
}

export async function runProbe(targets: ProbeTargets, fetcher: Fetch = fetch): Promise<ProbeResult> {
    const [rootError, api, publicSeen] = await Promise.all([
        probeRoot(fetcher, targets.appUrl),
        probeApi(fetcher, targets),
        targets.publicUrl ? probePublic(fetcher, targets.publicUrl) : Promise.resolve(null)
    ]);
    return {
        app: appObservation(rootError, api),
        public: publicSeen,
        features: api.kind === 'ok' ? api.probe.features : null,
        version: api.kind === 'ok' ? api.probe.version : null,
        refused: api.kind === 'refused'
    };
}
