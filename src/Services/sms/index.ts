import { env } from '@/Utils/Env';
import { createOvhSms, type OvhSms } from './ovh';

export { OvhReceiverRefusedError as SmsReceiverRefusedError } from './ovh';

/** Sur 24 h glissantes : un SMS coûte, et une rafale ne coupe que sa provenance. */
const DAY_MS = 24 * 3600_000;
const PER_ACCOUNT = 10;
const PER_IP = 20;

/** Le plafond d'un compte ou d'une adresse est atteint : rien n'est parti. */
export class SmsQuotaError extends Error {
    constructor() {
        super('Trop de SMS envoyés aujourd’hui : réessayez demain.');
        this.name = 'SmsQuotaError';
    }
}

const ovh: OvhSms | null =
    env.SMS_OVH_ENDPOINT &&
    env.SMS_OVH_APP_KEY &&
    env.SMS_OVH_APP_SECRET &&
    env.SMS_OVH_CONSUMER_KEY &&
    env.SMS_OVH_SERVICE
        ? createOvhSms({
              endpoint: env.SMS_OVH_ENDPOINT,
              appKey: env.SMS_OVH_APP_KEY,
              appSecret: env.SMS_OVH_APP_SECRET,
              consumerKey: env.SMS_OVH_CONSUMER_KEY,
              service: env.SMS_OVH_SERVICE,
              sender: env.SMS_OVH_SENDER || undefined
          })
        : null;

const sent = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
    const kept = (sent.get(key) ?? []).filter((at) => now - at < DAY_MS);
    if (kept.length > 0) sent.set(key, kept);
    else sent.delete(key);
    return kept;
}

/** L'expéditeur de SMS du serveur (`SMS_OVH_*`) : sans lui, la confirmation par SMS n'existe pas. */
export const sms = {
    get available(): boolean {
        return ovh !== null;
    },

    /** Un SMS pour ce compte, depuis cette adresse ; `SmsQuotaError` passé leur plafond du jour. */
    async send(to: string, text: string, from: { userId: number; ip: string }): Promise<void> {
        if (!ovh) throw new Error('Aucun envoi de SMS configuré');
        const now = Date.now();
        const account = `user:${from.userId}`;
        const address = `ip:${from.ip}`;
        if (recent(account, now).length >= PER_ACCOUNT || recent(address, now).length >= PER_IP) {
            throw new SmsQuotaError();
        }
        for (const key of [account, address]) sent.set(key, [...recent(key, now), now]);
        await ovh.send(to, text);
    },

    /** Les crédits qui restent chez OVH, pour la page Services externes. */
    credits(): Promise<number> {
        if (!ovh) return Promise.reject(new Error('Aucun envoi de SMS configuré'));
        return ovh.credits();
    }
};
