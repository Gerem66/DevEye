import { databaseInspect, databaseQuery, databaseTest, databaseTestDraft } from '../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { explainError, openSession, type Session } from './engine';
import { loadDatabase, monitorOf, reloadDatabase, type Ctx } from './_shared';

/**
 * Ce qui joint réellement un serveur.
 *
 * Toutes ces commandes sont déclenchées par un geste explicite : c'est ce qui
 * fait de « à la demande » le comportement par défaut de la feature. Aucune n'a
 * de `mutates` sauf `inspect`, qui écrit le résultat de son relevé.
 *
 * **Le droit d'écriture, pas de lecture.** Lire une base, même en `SELECT`,
 * consomme une connexion sur un serveur tiers et expose son contenu ; ce n'est
 * pas du même ordre que consulter un inventaire. Un membre en lecture voit donc
 * la fiche d'une base, pas ses tables.
 */

/**
 * Ouvre une session vers une base visible de l'espace, secrets déchiffrés côté
 * service.
 *
 * La cible se déchiffre sous la clé de **son** espace (`row.workspace_id`),
 * pas sous celle de l'appelant : une base projetée reste chiffrée chez elle,
 * et la lire d'une fenêtre avec le codec d'ici rendait « réglages illisibles »
 * là où le partage promet une base qu'on peut ouvrir.
 */
async function sessionFor(ctx: Ctx, databaseId: number): Promise<Session> {
    const row = await loadDatabase(ctx, databaseId);
    const monitor = monitorOf();
    try {
        return await openSession(await monitor.targetOf(row, row.workspace_id));
    } catch (e) {
        // Un serveur injoignable est une réponse attendue, pas un incident du
        // dispatcheur : on la traduit en message clair plutôt qu'en `internal`.
        throw new FeatureError('conflict', explainError(e));
    }
}

/** Ouvre, fait, referme — le `finally` est ce qui empêche les tunnels de fuir. */
export async function withSession<T>(ctx: Ctx, databaseId: number, run: (s: Session) => Promise<T>): Promise<T> {
    const session = await sessionFor(ctx, databaseId);
    try {
        return await run(session);
    } catch (e) {
        if (e instanceof FeatureError) throw e;
        throw new FeatureError('conflict', explainError(e));
    } finally {
        try {
            await session.close();
        } catch {
            /* la fermeture d'une session déjà morte n'a rien à dire */
        }
    }
}

export const databaseProbeFeatures = [
    defineSdkFeature({
        ...databaseTest,
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => {
            await loadDatabase(ctx, input.databaseId);
            const started = Date.now();
            // Ne lève **jamais** : un échec de connexion est le résultat normal
            // d'un test, et l'interface doit pouvoir l'afficher sans traiter une
            // erreur de commande.
            try {
                const version = await withSession(ctx, input.databaseId, (s) => s.serverVersion());
                return { probe: { ok: true, serverVersion: version, elapsedMs: Date.now() - started, error: null } };
            } catch (e) {
                const message = e instanceof FeatureError ? e.message : explainError(e);
                return { probe: { ok: false, serverVersion: null, elapsedMs: Date.now() - started, error: message } };
            }
        }
    }),
    /**
     * Le même essai, mais sur des réglages **pas encore enregistrés**.
     *
     * Sans lui, on ne peut vérifier une base qu'après l'avoir créée : on
     * enregistrerait pour découvrir qu'un port est faux, puis on corrigerait — alors
     * que l'essai ne coûte qu'une connexion.
     *
     * N'écrit rien : ni ligne, ni état de la base. Un échec reste une réponse, pas
     * une erreur de commande, exactement comme pour `database.test`.
     */
    defineSdkFeature({
        ...databaseTestDraft,
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => {
            const cipher = ctx.cipher();
            let password = input.password ?? null;
            let accessSecret = input.access.secret ?? null;

            // Champ laissé intact : le secret enregistré prend le relais. Il est lu
            // sur la base **visée**, que `loadDatabase` borne à l'espace actif — on
            // ne peut donc pas essayer le mot de passe d'autrui sur son propre hôte.
            if (input.databaseId !== undefined && (input.password === undefined || input.access.secret === undefined)) {
                const row = await loadDatabase(ctx, input.databaseId);
                if (input.password === undefined) {
                    password = row.secret_enc ? await cipher.tryDecrypt(row.secret_enc) : null;
                }
                if (input.access.secret === undefined) {
                    accessSecret = row.access_secret_enc ? await cipher.tryDecrypt(row.access_secret_enc) : null;
                }
            }

            const started = Date.now();
            let session: Session | null = null;
            try {
                session = await openSession({
                    engine: input.engine,
                    host: input.host,
                    port: input.port,
                    database: input.database,
                    username: input.username,
                    password,
                    access: { ...input.access, secret: accessSecret }
                });
                const version = await session.serverVersion();
                return { probe: { ok: true, serverVersion: version, elapsedMs: Date.now() - started, error: null } };
            } catch (e) {
                return {
                    probe: { ok: false, serverVersion: null, elapsedMs: Date.now() - started, error: explainError(e) }
                };
            } finally {
                try {
                    await session?.close();
                } catch {
                    /* la fermeture d'une session déjà morte n'a rien à dire */
                }
            }
        }
    }),
    /**
     * Relève l'inventaire maintenant, alertes comprises.
     *
     * Passe par le **même chemin que l'ordonnanceur** (`DatabaseMonitor.checkNow`) :
     * un relevé manuel donne donc exactement le même résultat qu'un relevé
     * automatique, notifications incluses. Deux implémentations auraient divergé au
     * premier ajustement.
     */
    defineSdkFeature({
        ...databaseInspect,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadDatabase(ctx, input.databaseId);
            // Le relevé lit la base chez elle (`find` du domicile) et diffuse à
            // son espace, projections comprises : d'une fenêtre, on relève la
            // base là où elle vit.
            const probe = await monitorOf().checkNow(input.databaseId, row.workspace_id);
            return { database: await reloadDatabase(ctx, input.databaseId), probe };
        }
    }),
    defineSdkFeature({
        ...databaseQuery,
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => ({
            // `session.query` refuse tout ce qui n'est pas une lecture unique — voir
            // `assertReadOnly`. Le compte utilisé reste celui saisi par
            // l'utilisateur : c'est lui, en dernier ressort, qui décide.
            rows: await withSession(ctx, input.databaseId, (s) => s.query(input.sql))
        })
    })
];
