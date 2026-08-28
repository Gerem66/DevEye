import { MAIL_TRANSPORT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { mailHandlers } from './handlers';
import { createRepo, type MailRepo } from './repo';
import { mailRoutes } from './routes';
import { MailSync } from './service';
import { createMailTransport } from './transport';

/**
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait : la relève de fond
 * des boîtes ouvertes (`MailSync`, l'ex `Services/MailSyncService.ts`)
 * démarrée avec les autres services, le contrat offert à l'app pour les
 * alertes e-mail des autres features (`MAIL_TRANSPORT_PROVIDER` : les
 * expéditeurs prêts, et l'envoi d'un texte depuis l'un d'eux, ce que
 * `Services/notifications.ts` faisait en lisant `mail_accounts` lui-même), et
 * les **routes publiques** (`publicRoutes`, capacité `routes.public`,
 * `exposure: 'app'`) : le téléchargement d'une pièce jointe et le retour
 * OAuth, toutes deux à ticket de session, que `app.ts` montait à la main
 * (`mailAttachmentRoutes`, `mailOAuthRoutes`).
 *
 * Mail ne notifie personne (`notifies: false`) : aucune capacité `notify`. La
 * façade `mail.listAccounts` des autres modules lit le même contrat que l'app.
 *
 * `items` est ce que le partage sait des comptes sans ouvrir la feature : le
 * domicile d'un compte visible d'ici (le sien, ou l'espace qui le projette),
 * son intitulé déchiffré par le codec ouvert de l'espace appelant, et son
 * palier (`shareable` : une boîte ouverte se projette, une boîte gardée est
 * chiffrée par le mot de passe de son auteur et ne se lit nulle part
 * ailleurs). `shareTier: 'perItem'` l'exige ; le boot refuse un module qui
 * déclare sans l'offrir.
 *
 * Pas de `migrationsDir` : les quatre tables du module datent du socle (039
 * et suivantes, rattachées à l'espace par la 050, jamais déplacées, allowlist
 * dans deveye-feature.json) ; une nouvelle table inaugurera
 * `src/server/migrations/` avec le préfixe `ft_mail_`.
 */
export const serverEntry: FeatureServer<MailRepo> = {
    createRepo,
    features: mailHandlers,
    createService(deps) {
        const sync = new MailSync(deps);
        return {
            start() {
                sync.start();
            },
            stop() {
                sync.stop();
            },
            providers: { [MAIL_TRANSPORT_PROVIDER]: createMailTransport(deps) },
            // Les mêmes deux routes à chaque appel ; l'écouteur public, lui,
            // les ignore (`exposure: 'app'`).
            publicRoutes: (app) => mailRoutes(app, deps)
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.accounts.findVisible(itemId, workspaceId))?.workspace_id ?? null,
        // Le nom, ou à défaut l'adresse, sous le codec ouvert de l'espace
        // appelant : un compte gardé ou disparu vaut `null`, ce que l'écran
        // montre comme « une cible disparue ».
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.accounts.findById(itemId, workspaceId);
            if (!row) return null;
            const name = await cipher.tryDecrypt(row.display_name_enc);
            if (name) return name;
            return (await cipher.tryDecrypt(row.email_address_enc)) || null;
        },
        // Demandé avec le domicile du compte : seule une boîte ouverte se lit
        // sous une clé que le serveur tient seul, donc dans un autre espace.
        shareable: async (repo, itemId, workspaceId) =>
            (await repo.accounts.findById(itemId, workspaceId))?.security_tier === 'open'
    }
};
