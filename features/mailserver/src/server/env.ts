/**
 * Les variables d'environnement du serveur mail. L'identité du serveur (nom
 * d'hôte, ports, certificat) appartient au PROCESSUS : un seul jeu d'écouteurs
 * sert tous les espaces, qui ne déclarent que leurs domaines et leurs adresses.
 */

const text = (name: string): string => (process.env[name] ?? '').trim();
const int = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
};
const flag = (name: string, fallback: boolean): boolean => {
    const value = text(name).toLowerCase();
    return value === '' ? fallback : value === 'true' || value === '1';
};

export const env = {
    /**
     * Le nom sous lequel le serveur se présente et que les MX visent
     * (`mail.exemple.fr`). Vide : rien n'écoute, la feature ne fait que ranger
     * des adresses.
     */
    MAILSERVER_HOSTNAME: text('MAILSERVER_HOSTNAME').toLowerCase(),
    MAILSERVER_STORAGE_DIR: text('MAILSERVER_STORAGE_DIR') || '/data/mailserver',

    /** Les ports du conteneur. Hauts par défaut : le compose les relie à 25, 465, 587 et 993. */
    MAILSERVER_PORT_SMTP: int('MAILSERVER_PORT_SMTP', 2525),
    MAILSERVER_PORT_SUBMISSIONS: int('MAILSERVER_PORT_SUBMISSIONS', 4465),
    MAILSERVER_PORT_SUBMISSION: int('MAILSERVER_PORT_SUBMISSION', 5587),
    MAILSERVER_PORT_IMAPS: int('MAILSERVER_PORT_IMAPS', 9993),
    /** Les ports que les clients voient, annoncés dans l'interface et à Mails. */
    MAILSERVER_PUBLIC_PORT_SUBMISSIONS: int('MAILSERVER_PUBLIC_PORT_SUBMISSIONS', 465),
    MAILSERVER_PUBLIC_PORT_SUBMISSION: int('MAILSERVER_PUBLIC_PORT_SUBMISSION', 587),
    MAILSERVER_PUBLIC_PORT_IMAPS: int('MAILSERVER_PUBLIC_PORT_IMAPS', 993),

    MAILSERVER_MAX_MESSAGE_MB: int('MAILSERVER_MAX_MESSAGE_MB', 25),

    /**
     * Une paire PEM fournie par l'opérateur passe devant ACME : pour un proxy
     * qui garde le défi HTTP-01 pour lui, ou un certificat obtenu ailleurs.
     */
    MAILSERVER_TLS_CERT_FILE: text('MAILSERVER_TLS_CERT_FILE'),
    MAILSERVER_TLS_KEY_FILE: text('MAILSERVER_TLS_KEY_FILE'),
    MAILSERVER_ACME_EMAIL: text('MAILSERVER_ACME_EMAIL'),
    /** `staging` délivre des certificats de test que les clients refusent : pour essayer sans brûler de quota. */
    MAILSERVER_ACME_DIRECTORY: text('MAILSERVER_ACME_DIRECTORY') === 'staging' ? 'staging' : 'production',

    MAILSERVER_EVENTS_RETENTION_DAYS: int('MAILSERVER_EVENTS_RETENTION_DAYS', 90),
    /** Sans PTR en IPv6, les grands fournisseurs refusent : l'IPv4 seul est le défaut sûr. */
    MAILSERVER_OUTBOUND_IPV4_ONLY: flag('MAILSERVER_OUTBOUND_IPV4_ONLY', true),
    /** Pour les tests seulement : laisse la remise viser une adresse privée. */
    MAILSERVER_ALLOW_PRIVATE_MX: flag('MAILSERVER_ALLOW_PRIVATE_MX', false)
} as const;

export const maxMessageBytes = (): number => env.MAILSERVER_MAX_MESSAGE_MB * 1024 * 1024;
