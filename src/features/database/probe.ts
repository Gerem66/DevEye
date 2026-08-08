import {
    databaseInspect,
    databaseQuery,
    databaseTableList,
    databaseTableRows,
    databaseTest,
    databaseTestDraft
} from 'deveye-types';
import type { DatabaseTable } from 'deveye-types';
import { explainError, openSession, ROWS_PAGE_DEFAULT, type Session } from '@/Services/databases/engine';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { databaseCipher, loadDatabase, monitorOf, READ, reloadDatabase, WRITE } from './_shared';

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

/** Ouvre une session vers une base de l'espace, secrets déchiffrés côté service. */
async function sessionFor(ctx: FeatureContext, databaseId: number): Promise<Session> {
    const row = await loadDatabase(ctx, databaseId);
    const monitor = monitorOf(ctx);
    try {
        return await openSession(await monitor.targetOf(row, ctx.workspaceId));
    } catch (e) {
        // Un serveur injoignable est une réponse attendue, pas un incident du
        // dispatcheur : on la traduit en message clair plutôt qu'en `internal`.
        throw new FeatureError('conflict', explainError(e));
    }
}

/** Ouvre, fait, referme — le `finally` est ce qui empêche les tunnels de fuir. */
async function withSession<T>(ctx: FeatureContext, databaseId: number, run: (s: Session) => Promise<T>): Promise<T> {
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

export const databaseTestFeature: FeatureDefinition<
    typeof databaseTest.command,
    typeof databaseTest.input,
    typeof databaseTest.output
> = defineFeature({
    ...databaseTest,
    access: WRITE,
    handler: async (ctx, input) => {
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
});

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
export const databaseTestDraftFeature: FeatureDefinition<
    typeof databaseTestDraft.command,
    typeof databaseTestDraft.input,
    typeof databaseTestDraft.output
> = defineFeature({
    ...databaseTestDraft,
    access: WRITE,
    handler: async (ctx, input) => {
        const cipher = databaseCipher(ctx);
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
});

/**
 * Relève l'inventaire maintenant, alertes comprises.
 *
 * Passe par le **même chemin que l'ordonnanceur** (`DatabaseMonitor.checkNow`) :
 * un relevé manuel donne donc exactement le même résultat qu'un relevé
 * automatique, notifications incluses. Deux implémentations auraient divergé au
 * premier ajustement.
 */
export const databaseInspectFeature: FeatureDefinition<
    typeof databaseInspect.command,
    typeof databaseInspect.input,
    typeof databaseInspect.output
> = defineFeature({
    ...databaseInspect,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadDatabase(ctx, input.databaseId);
        const probe = await monitorOf(ctx).checkNow(input.databaseId, ctx.workspaceId);
        return { database: await reloadDatabase(ctx, input.databaseId), probe };
    }
});

export const databaseTableListFeature: FeatureDefinition<
    typeof databaseTableList.command,
    typeof databaseTableList.input,
    typeof databaseTableList.output
> = defineFeature({
    ...databaseTableList,
    access: WRITE,
    handler: async (ctx, input) => ({
        tables: await withSession(ctx, input.databaseId, (s) => s.tables())
    })
});

export const databaseTableRowsFeature: FeatureDefinition<
    typeof databaseTableRows.command,
    typeof databaseTableRows.input,
    typeof databaseTableRows.output
> = defineFeature({
    ...databaseTableRows,
    access: WRITE,
    handler: async (ctx, input) => {
        const rows = await withSession(ctx, input.databaseId, async (s) => {
            // Un identifiant de table ne peut pas être un paramètre lié : la
            // seule façon sûre de le nommer est de le confronter d'abord à la
            // liste réelle des tables. Un nom qui n'y figure pas n'atteint
            // jamais la requête.
            const tables: DatabaseTable[] = await s.tables();
            const found = tables.find(
                (t) => t.name === input.table && (input.schema === '' || t.schema === input.schema)
            );
            if (!found) throw new FeatureError('not_found', 'Cette table n’existe pas dans cette base.');
            return s.tableRows(found.schema, found.name, input.offset ?? 0, input.limit ?? ROWS_PAGE_DEFAULT);
        });
        return { rows };
    }
});

export const databaseQueryFeature: FeatureDefinition<
    typeof databaseQuery.command,
    typeof databaseQuery.input,
    typeof databaseQuery.output
> = defineFeature({
    ...databaseQuery,
    access: WRITE,
    handler: async (ctx, input) => ({
        // `session.query` refuse tout ce qui n'est pas une lecture unique — voir
        // `assertReadOnly`. Le compte utilisé reste celui saisi par
        // l'utilisateur : c'est lui, en dernier ressort, qui décide.
        rows: await withSession(ctx, input.databaseId, (s) => s.query(input.sql))
    })
});

export const databaseProbeFeatures = [
    databaseTestFeature,
    databaseTestDraftFeature,
    databaseInspectFeature,
    databaseTableListFeature,
    databaseTableRowsFeature,
    databaseQueryFeature
];

/** Exporté pour les alertes, qui ouvrent elles aussi une session éphémère. */
export { withSession };
export const READ_ACCESS = READ;
