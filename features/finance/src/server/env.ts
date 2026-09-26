import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/**
 * Les variables propres à Finances. Toutes deux facultatives : sans elles,
 * « Autre banque » ne se propose pas, et Qonto comme l'import marchent quand même.
 */
export const FINANCE_ENV = defineModuleEnv({
    /**
     * L'application Enable Banking de l'instance (enablebanking.com, Control
     * Panel). En mode restreint, gratuit, seuls les comptes que son propriétaire
     * a reliés s'ouvrent : c'est ce qui convient à une instance auto-hébergée.
     * L'URI de redirection à déclarer est `<origine de l'app>/api/finance/bank/callback`.
     */
    ENABLE_BANKING_APP_ID: { kind: 'text', default: '', optional: true },
    /** La clé privée de l'application, en PEM (les retours à la ligne écrits `\n`) ou en base64 du PEM. */
    ENABLE_BANKING_PRIVATE_KEY: { kind: 'secret', optional: true }
});

export const env = readModuleEnv(FINANCE_ENV).values;
