import { createHash } from 'node:crypto';

/**
 * L'API SMS d'OVHcloud, sans dépendance : chaque requête est signée par la clé
 * d'application, sa clé secrète et la clé du consommateur, à l'heure d'OVH (un
 * écart d'horloge fait refuser la signature).
 */
export interface OvhSmsConfig {
    /** `https://eu.api.ovh.com/1.0`, sans barre finale. */
    endpoint: string;
    appKey: string;
    appSecret: string;
    consumerKey: string;
    /** Le compte SMS, `sms-xx12345-1`. */
    service: string;
    /** L'expéditeur validé chez OVH ; absent, un numéro court d'OVH. */
    sender?: string;
}

/** OVH a refusé le destinataire : le numéro, pas le service, est en cause. */
export class OvhReceiverRefusedError extends Error {
    constructor() {
        super('OVH a refusé ce numéro');
        this.name = 'OvhReceiverRefusedError';
    }
}

/** Relue au plus toutes les dix minutes : l'écart bouge peu. */
const CLOCK_TTL_MS = 10 * 60_000;

/** La signature d'OVH : `$1$` et le SHA-1 de ces six champs joints par `+`. */
export function ovhSignature(
    appSecret: string,
    consumerKey: string,
    method: string,
    url: string,
    body: string,
    timestamp: number
): string {
    const digest = createHash('sha1')
        .update([appSecret, consumerKey, method, url, body, String(timestamp)].join('+'))
        .digest('hex');
    return `$1$${digest}`;
}

export function createOvhSms(config: OvhSmsConfig, fetchImpl: typeof fetch = fetch) {
    const base = config.endpoint.replace(/\/+$/, '');
    let clock: { delta: number; readAt: number } | null = null;

    /** L'heure d'OVH, en secondes : la nôtre corrigée de l'écart mesuré. */
    const ovhNow = async (): Promise<number> => {
        const now = Date.now();
        if (!clock || now - clock.readAt > CLOCK_TTL_MS) {
            const res = await fetchImpl(`${base}/auth/time`, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(`OVH /auth/time : HTTP ${res.status}`);
            const remote = Number(await res.text());
            if (!Number.isFinite(remote)) throw new Error('OVH /auth/time : réponse illisible');
            clock = { delta: remote - Math.floor(now / 1000), readAt: now };
        }
        return Math.floor(Date.now() / 1000) + clock.delta;
    };

    const call = async <T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> => {
        const url = `${base}${path}`;
        const body = payload === undefined ? '' : JSON.stringify(payload);
        const timestamp = await ovhNow();
        const res = await fetchImpl(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Ovh-Application': config.appKey,
                'X-Ovh-Consumer': config.consumerKey,
                'X-Ovh-Timestamp': String(timestamp),
                'X-Ovh-Signature': ovhSignature(config.appSecret, config.consumerKey, method, url, body, timestamp)
            },
            ...(body ? { body } : {}),
            signal: AbortSignal.timeout(15_000)
        });
        const text = await res.text();
        if (!res.ok) {
            let message = text;
            try {
                message = (JSON.parse(text) as { message?: string }).message ?? text;
            } catch {
                // Le corps brut dit ce qu'il dit.
            }
            throw new Error(`OVH ${method} ${path} : HTTP ${res.status} ${message}`.trim());
        }
        return JSON.parse(text) as T;
    };

    const service = encodeURIComponent(config.service);

    return {
        /** Un SMS à un numéro au format international (`+33612345678`). */
        async send(to: string, message: string): Promise<void> {
            const job = await call<{ invalidReceivers?: string[]; validReceivers?: string[] }>(
                'POST',
                `/sms/${service}/jobs`,
                {
                    charset: 'UTF-8',
                    coding: '7bit',
                    message,
                    // Un message de service, pas de prospection : pas de « STOP » à répondre.
                    noStopClause: true,
                    priority: 'high',
                    receivers: [to],
                    ...(config.sender ? { sender: config.sender } : { senderForResponse: true })
                }
            );
            if (job.invalidReceivers?.length || !job.validReceivers?.length) throw new OvhReceiverRefusedError();
        },
        /** Les crédits SMS qui restent sur le compte. */
        async credits(): Promise<number> {
            const account = await call<{ creditsLeft: number }>('GET', `/sms/${service}`);
            return account.creditsLeft;
        }
    };
}

export type OvhSms = ReturnType<typeof createOvhSms>;
