import { MAIL_TRANSPORT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { mailHandlers } from './handlers';
import { mailCopy } from './copy';
import { mailMove } from './move';
import { createRepo, type MailRepo } from './repo';
import { mailRoutes } from './routes';
import { MailSync } from './service';
import { createMailTransport } from './transport';
import { MAIL_ENV } from './env';

/**
 * L'entrée serveur du module : la relève de fond des boîtes ouvertes
 * (`MailSync`), le contrat d'envoi offert aux autres features
 * (`MAIL_TRANSPORT_PROVIDER`), et les deux routes publiques à ticket de session
 * (pièce jointe, retour OAuth). Mail ne notifie personne (`notifies: false`).
 *
 * `items` est ce que le partage sait des comptes sans ouvrir la feature :
 * `shareTier: 'perItem'` l'exige, et le boot refuse un module qui déclare sans
 * l'offrir.
 *
 * Pas de `migrationsDir` : les tables du module datent du socle et sont dans
 * l'allowlist de `deveye-feature.json` ; une nouvelle table inaugurerait
 * `src/server/migrations/` avec le préfixe `ft_mail_`.
 */
export const serverEntry: FeatureServer<MailRepo> = {
    env: MAIL_ENV,
    createRepo,
    features: mailHandlers,
    createService(deps) {
        const sync = new MailSync(deps);
        return {
            start() {
                sync.start();
            },
            stop() {
                return sync.stop();
            },
            providers: { [MAIL_TRANSPORT_PROVIDER]: createMailTransport(deps) },
            publicRoutes: (app) => mailRoutes(app, deps)
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.accounts.findVisible(Number(itemId), workspaceId))?.workspace_id ?? null,
        // Le nom, ou à défaut l'adresse : un compte gardé ou disparu vaut `null`,
        // ce que l'écran montre comme « une cible disparue ».
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.accounts.findById(Number(itemId), workspaceId);
            if (!row) return null;
            const name = await cipher.tryDecrypt(row.display_name_enc);
            if (name) return name;
            return (await cipher.tryDecrypt(row.email_address_enc)) || null;
        },
        // Demandé avec le domicile du compte : seule une boîte ouverte se lit
        // sous une clé que le serveur tient seul, donc dans un autre espace.
        shareable: async (repo, itemId, workspaceId) =>
            (await repo.accounts.findById(Number(itemId), workspaceId))?.security_tier === 'open',
        move: mailMove,
        copy: mailCopy
    },
    quotas: { accounts: { list: (repo, owned) => repo.accounts.listStock(owned) } }
};
