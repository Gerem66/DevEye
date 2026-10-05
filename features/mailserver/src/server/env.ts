import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/**
 * Les variables d'environnement du serveur mail. L'identité du serveur (nom
 * d'hôte, ports, certificat) appartient au PROCESSUS : un seul jeu d'écouteurs
 * sert tous les espaces, qui ne déclarent que leurs domaines et leurs adresses.
 */
export const MAILSERVER_ENV = defineModuleEnv({
    /**
     * Le nom sous lequel le serveur se présente et que les MX visent
     * (`mail.exemple.fr`). Vide : rien n'écoute, la feature ne fait que ranger
     * des adresses.
     */
    MAILSERVER_HOSTNAME: { kind: 'text', default: '' },
    MAILSERVER_STORAGE_DIR: { kind: 'path', default: '/data/mailserver' },

    /** Les ports du conteneur. Hauts par défaut : le compose les relie à 25, 465, 587 et 993. */
    MAILSERVER_PORT_SMTP: { kind: 'int', default: 2525, min: 0 },
    MAILSERVER_PORT_SUBMISSIONS: { kind: 'int', default: 4465, min: 0 },
    MAILSERVER_PORT_SUBMISSION: { kind: 'int', default: 5587, min: 0 },
    MAILSERVER_PORT_IMAPS: { kind: 'int', default: 9993, min: 0 },
    /** Les ports que les clients voient, annoncés dans l'interface et à Mail. */
    MAILSERVER_PUBLIC_PORT_SUBMISSIONS: { kind: 'int', default: 465, min: 0 },
    MAILSERVER_PUBLIC_PORT_SUBMISSION: { kind: 'int', default: 587, min: 0 },
    MAILSERVER_PUBLIC_PORT_IMAPS: { kind: 'int', default: 993, min: 0 },

    MAILSERVER_MAX_MESSAGE_MB: { kind: 'int', default: 25, min: 0 },

    /**
     * Une paire PEM fournie par l'opérateur passe devant ACME : pour un proxy
     * qui garde le défi HTTP-01 pour lui, ou un certificat obtenu ailleurs.
     */
    MAILSERVER_TLS_CERT_FILE: { kind: 'path', default: '', optional: true },
    MAILSERVER_TLS_KEY_FILE: { kind: 'path', default: '', optional: true },
    MAILSERVER_ACME_EMAIL: { kind: 'text', default: '', optional: true },
    /** `staging` délivre des certificats de test que les clients refusent : pour essayer sans brûler de quota. */
    MAILSERVER_ACME_DIRECTORY: { kind: 'choice', default: 'production', choices: ['production', 'staging'] },

    MAILSERVER_EVENTS_RETENTION_DAYS: { kind: 'int', default: 90, min: 0 },
    /** Sans PTR en IPv6, les grands fournisseurs refusent : l'IPv4 seul est le défaut sûr. */
    MAILSERVER_OUTBOUND_IPV4_ONLY: { kind: 'flag', default: true },
    /** Pour les tests seulement : laisse la remise viser une adresse privée. */
    MAILSERVER_ALLOW_PRIVATE_MX: { kind: 'flag', default: false, optional: true }
});

const values = readModuleEnv(MAILSERVER_ENV).values;

export const env = { ...values, MAILSERVER_HOSTNAME: values.MAILSERVER_HOSTNAME.toLowerCase() };

export const maxMessageBytes = (): number => env.MAILSERVER_MAX_MESSAGE_MB * 1024 * 1024;
