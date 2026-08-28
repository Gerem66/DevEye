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
 * Pas d'entrée `items` : le manifest déclare `shareTier: 'never'` par-dessus
 * le `'perItem'` du descripteur publié, parce que le listage n'est pas
 * branché sur le partage (voir `manifest.ts`). Le jour où il l'est, `items`
 * arrive ici en même temps que `ctx.sharing.scope()` dans `mail.accountList`.
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
    }
};
