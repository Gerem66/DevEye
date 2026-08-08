import {
    databaseAdd,
    databaseCount,
    databaseGet,
    databaseList,
    databaseRemove,
    databaseReorder,
    databaseUpdate
} from 'deveye-types';
import type { DatabaseUsage } from 'deveye-types';
import type { StoredAccess, StoredDatabase } from '@/Services/DatabaseMonitor';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { tryDecryptProject } from '../project/_shared';
import { databaseCipher, loadDatabase, nameRef, READ, reloadDatabase, toAlert, toDatabase, WRITE } from './_shared';

/**
 * Les bases de l'espace : inventaire, réglages, suppression, ordre.
 *
 * **Rien ici ne joint un serveur.** `list` et `get` lisent le cache local ;
 * ouvrir la feature n'ouvre aucune connexion sortante. Ce sont les commandes de
 * `probe.ts` qui vont voir, et seulement quand on le leur demande.
 */

export const databaseCountFeature: FeatureDefinition<
    typeof databaseCount.command,
    typeof databaseCount.input,
    typeof databaseCount.output
> = defineFeature({
    ...databaseCount,
    access: READ,
    handler: async (ctx) => ({ count: await ctx.db.databases.count(ctx.workspaceId) })
});

export const databaseListFeature: FeatureDefinition<
    typeof databaseList.command,
    typeof databaseList.input,
    typeof databaseList.output
> = defineFeature({
    ...databaseList,
    access: READ,
    handler: async (ctx) => {
        const cipher = databaseCipher(ctx);
        const rows = await ctx.db.databases.list(ctx.workspaceId);
        return { databases: await Promise.all(rows.map((row) => toDatabase(cipher, row))) };
    }
});

export const databaseGetFeature: FeatureDefinition<
    typeof databaseGet.command,
    typeof databaseGet.input,
    typeof databaseGet.output
> = defineFeature({
    ...databaseGet,
    access: READ,
    handler: async (ctx, input) => {
        const row = await ctx.db.databases.findWithStats(input.databaseId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Base de données introuvable');
        const cipher = databaseCipher(ctx);

        // Les projets liés, avec leur titre : c'est ce qui rend l'interconnexion
        // cliquable dans les deux sens. Ils sont tous à l'étage ouvert (la
        // requête le garantit), donc lisibles sans session.
        const usage: DatabaseUsage[] = await Promise.all(
            (await ctx.db.databases.listUsage(input.databaseId, ctx.workspaceId)).map(async (u) => ({
                projectId: u.project_id,
                title: (await tryDecryptProject(cipher, u.content))?.title || 'Sans titre',
                status: u.status as DatabaseUsage['status']
            }))
        );

        const alertRows = await ctx.db.databases.listAlerts(input.databaseId, ctx.workspaceId);
        return {
            database: await toDatabase(cipher, row),
            usage,
            alerts: await Promise.all(alertRows.map((a) => toAlert(cipher, a)))
        };
    }
});

/** Ce que le client envoie pour décrire un accès, sans son secret. */
function accessBody(input: {
    kind: StoredAccess['kind'];
    host: string;
    port: number | null;
    username: string;
    auth: StoredAccess['auth'];
}): StoredAccess {
    return {
        kind: input.kind,
        host: input.host.trim(),
        port: input.port,
        username: input.username.trim(),
        auth: input.auth
    };
}

export const databaseAddFeature: FeatureDefinition<
    typeof databaseAdd.command,
    typeof databaseAdd.input,
    typeof databaseAdd.output
> = defineFeature({
    ...databaseAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const cipher = databaseCipher(ctx);
        const ref = nameRef(input.name);

        // Le nom porte l'unicité : deux bases homonymes dans un même espace ne
        // se distingueraient nulle part dans l'interface.
        if (await ctx.db.databases.findByName(ctx.workspaceId, ref)) {
            throw new FeatureError('conflict', 'Une base porte déjà ce nom dans cet espace.');
        }

        const body: StoredDatabase = {
            name: input.name.trim(),
            host: input.host.trim(),
            port: input.port,
            database: input.database.trim(),
            username: input.username.trim(),
            autoLoadTables: input.autoLoadTables
        };

        const row = await ctx.db.databases.create({
            workspaceId: ctx.workspaceId,
            engine: input.engine,
            nameRef: ref,
            content: await cipher.encrypt(JSON.stringify(body)),
            secretEnc: input.password ? await cipher.encrypt(input.password) : null,
            accessContent: await cipher.encrypt(JSON.stringify(accessBody(input.access))),
            accessSecretEnc: input.access.secret ? await cipher.encrypt(input.access.secret) : null,
            monitorEnabled: input.monitorEnabled,
            intervalSeconds: input.intervalSeconds
        });

        ctx.audit({
            action: 'database.add',
            description: 'Base de données ajoutée à l’espace',
            metadata: { databaseId: row.id, engine: input.engine }
        });
        return { database: await reloadDatabase(ctx, row.id) };
    }
});

export const databaseUpdateFeature: FeatureDefinition<
    typeof databaseUpdate.command,
    typeof databaseUpdate.input,
    typeof databaseUpdate.output
> = defineFeature({
    ...databaseUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadDatabase(ctx, input.databaseId);
        const cipher = databaseCipher(ctx);
        const ref = nameRef(input.name);

        const clash = await ctx.db.databases.findByName(ctx.workspaceId, ref);
        if (clash && clash.id !== input.databaseId) {
            throw new FeatureError('conflict', 'Une autre base porte déjà ce nom dans cet espace.');
        }

        const body: StoredDatabase = {
            name: input.name.trim(),
            host: input.host.trim(),
            port: input.port,
            database: input.database.trim(),
            username: input.username.trim(),
            autoLoadTables: input.autoLoadTables
        };

        // Secret absent = inchangé, chaîne vide = effacé. Le client ne le reçoit
        // jamais, il ne peut donc pas le renvoyer tel quel.
        const row = await ctx.db.databases.update(input.databaseId, ctx.workspaceId, {
            nameRef: ref,
            content: await cipher.encrypt(JSON.stringify(body)),
            secretEnc:
                input.password === undefined ? undefined : input.password ? await cipher.encrypt(input.password) : null,
            accessContent: await cipher.encrypt(JSON.stringify(accessBody(input.access))),
            accessSecretEnc:
                input.access.secret === undefined
                    ? undefined
                    : input.access.secret
                      ? await cipher.encrypt(input.access.secret)
                      : null,
            monitorEnabled: input.monitorEnabled,
            intervalSeconds: input.intervalSeconds
        });
        if (!row) throw new FeatureError('not_found', 'Base de données introuvable');
        return { database: await reloadDatabase(ctx, input.databaseId) };
    }
});

export const databaseRemoveFeature: FeatureDefinition<
    typeof databaseRemove.command,
    typeof databaseRemove.input,
    typeof databaseRemove.output
> = defineFeature({
    ...databaseRemove,
    // Deux sujets : les projets liés perdent leur base, leur onglet doit donc se
    // rafraîchir lui aussi.
    mutates: ['database', 'projects'],
    access: WRITE,
    handler: async (ctx, input) => {
        const ok = await ctx.db.databases.remove(input.databaseId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Base de données introuvable');
        ctx.audit({
            action: 'database.remove',
            description: 'Base de données retirée de l’espace',
            metadata: { databaseId: input.databaseId }
        });
        return { databaseId: input.databaseId };
    }
});

/**
 * Range les bases de l'espace.
 *
 * ⚠️ Le filet de démarrage ne voit pas cette commande : `MUTATION_VERB` cherche
 * un verbe juste après le point, et « reorder » y est précédé de rien du tout —
 * `database.reorder` correspond en fait au motif. Elle est donc bien vue, et
 * `mutates` ci-dessous est ce qu'il attend.
 */
export const databaseReorderFeature: FeatureDefinition<
    typeof databaseReorder.command,
    typeof databaseReorder.input,
    typeof databaseReorder.output
> = defineFeature({
    ...databaseReorder,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await ctx.db.databases.reorder(ctx.workspaceId, input.ids);
        return { ids: input.ids };
    }
});

export const databaseCrudFeatures = [
    databaseCountFeature,
    databaseListFeature,
    databaseGetFeature,
    databaseAddFeature,
    databaseUpdateFeature,
    databaseRemoveFeature,
    databaseReorderFeature
];
