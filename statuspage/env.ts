import { getEnvVar } from 'dotenv-oxy';

/**
 * La configuration de la page d'état, lue une fois au démarrage. Elle vit dans
 * son propre conteneur : rien de l'env de DevEye n'est requis ici, et
 * `src/Utils/Env.ts`, qui l'exige en entier, ne doit jamais être importé.
 */

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

function httpUrl(name: string, value: string): string {
    if (!/^https?:\/\/[^\s/]+/.test(value)) throw new Error(`${name} doit être une adresse http(s).`);
    return trimSlash(value);
}

function readEnv() {
    const environment = getEnvVar('ENVIRONMENT', 'enum', ['dev', 'test', 'prod']);
    const token = getEnvVar('STATUS_PROBE_TOKEN', 'string');
    if (token.length < 32) throw new Error('STATUS_PROBE_TOKEN doit faire au moins 32 caractères, le même que DevEye.');
    const publicUrl = getEnvVar('STATUS_DEVEYE_PUBLIC_URL', 'string', false);
    const siteUrl = getEnvVar('STATUS_SITE_URL', 'string', false);
    const smtpHost = getEnvVar('SMTP_HOST', 'string', false);
    const smtpFrom = getEnvVar('SMTP_FROM', 'string', false);
    if (smtpHost && !smtpFrom) throw new Error('SMTP_FROM est requis dès que SMTP_HOST est renseigné.');
    const interval = getEnvVar('STATUS_INTERVAL_SECONDS', 'number', false) || 60;
    if (interval < 15) throw new Error('STATUS_INTERVAL_SECONDS vaut 15 au moins.');

    return {
        environment,
        port: getEnvVar('STATUS_LISTEN_PORT', 'number', false) || 3100,
        /** L'adresse de l'app telle qu'un utilisateur la joint : proxy et certificat compris. */
        appUrl: httpUrl('STATUS_DEVEYE_URL', getEnvVar('STATUS_DEVEYE_URL', 'string')),
        /** L'écouteur des pages publiques (`AUDIENCE_ORIGIN`), s'il a son propre domaine. */
        publicUrl: publicUrl ? httpUrl('STATUS_DEVEYE_PUBLIC_URL', publicUrl) : null,
        token,
        dbPath: getEnvVar('STATUS_DB_PATH', 'string', false) || './statuspage/data/status.sqlite',
        intervalSeconds: interval,
        siteUrl: siteUrl ? httpUrl('STATUS_SITE_URL', siteUrl) : null,
        /** Prévenu même quand aucune destination n'a encore pu être lue chez DevEye. */
        fallbackEmail: getEnvVar('STATUS_ALERT_EMAIL', 'string', false) || null,
        smtp: {
            host: smtpHost,
            port: getEnvVar('SMTP_PORT', 'number', false) || 587,
            user: getEnvVar('SMTP_USER', 'string', false),
            password: getEnvVar('SMTP_PASSWORD', 'string', false),
            from: smtpFrom
        }
    };
}

export type StatusEnv = ReturnType<typeof readEnv>;

export const env: StatusEnv = readEnv();
