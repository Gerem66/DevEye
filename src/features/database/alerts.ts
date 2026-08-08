import {
    databaseAlertAdd,
    databaseAlertList,
    databaseAlertRemove,
    databaseAlertTest,
    databaseAlertUpdate
} from 'deveye-types';
import { isFiring, runConditions, type StoredAlert } from '@/Services/DatabaseMonitor';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { databaseCipher, loadDatabase, READ, toAlert, WRITE } from './_shared';
import { withSession } from './probe';

/**
 * Les alertes d'une base : des conditions SQL, un opérateur qui les relie, un
 * message.
 *
 * **Évaluées par le relevé périodique, et par lui seul.** Une alerte posée sur
 * une base dont la surveillance est éteinte est inerte : rien ne l'évalue, donc
 * rien ne la déclenchera. L'interface le dit plutôt que de laisser croire à une
 * surveillance qui n'existe pas.
 *
 * `database.alertTest` est l'exception : elle évalue tout de suite, à la
 * demande, **sans notifier personne**. C'est ce qui rend une condition
 * écrivable — on voit le nombre que rend la requête avant de choisir un seuil,
 * au lieu d'attendre une notification pour découvrir qu'on s'est trompé de
 * colonne.
 */

export const databaseAlertListFeature: FeatureDefinition<
    typeof databaseAlertList.command,
    typeof databaseAlertList.input,
    typeof databaseAlertList.output
> = defineFeature({
    ...databaseAlertList,
    access: READ,
    handler: async (ctx, input) => {
        await loadDatabase(ctx, input.databaseId);
        const cipher = databaseCipher(ctx);
        const rows = await ctx.db.databases.listAlerts(input.databaseId, ctx.workspaceId);
        return { alerts: await Promise.all(rows.map((row) => toAlert(cipher, row))) };
    }
});

export const databaseAlertAddFeature: FeatureDefinition<
    typeof databaseAlertAdd.command,
    typeof databaseAlertAdd.input,
    typeof databaseAlertAdd.output
> = defineFeature({
    ...databaseAlertAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadDatabase(ctx, input.databaseId);
        const cipher = databaseCipher(ctx);
        const stored: StoredAlert = {
            name: input.name.trim(),
            conditions: input.conditions,
            message: input.message,
            lastValues: []
        };
        const row = await ctx.db.databases.createAlert({
            databaseId: input.databaseId,
            workspaceId: ctx.workspaceId,
            enabled: input.enabled,
            combinator: input.combinator,
            content: await cipher.encrypt(JSON.stringify(stored))
        });
        return { alert: await toAlert(cipher, row) };
    }
});

export const databaseAlertUpdateFeature: FeatureDefinition<
    typeof databaseAlertUpdate.command,
    typeof databaseAlertUpdate.input,
    typeof databaseAlertUpdate.output
> = defineFeature({
    ...databaseAlertUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const cipher = databaseCipher(ctx);
        const existing = await ctx.db.databases.findAlert(input.alertId, ctx.workspaceId);
        if (!existing) throw new FeatureError('not_found', 'Alerte introuvable');

        // Les dernières mesures sont conservées : elles décrivent la dernière
        // évaluation, qui reste vraie tant qu'une nouvelle n'a pas eu lieu.
        const previous = await cipher.tryDecrypt(existing.content);
        let lastValues: (number | null)[] = [];
        try {
            lastValues = previous ? ((JSON.parse(previous) as StoredAlert).lastValues ?? []) : [];
        } catch {
            lastValues = [];
        }

        const stored: StoredAlert = {
            name: input.name.trim(),
            conditions: input.conditions,
            message: input.message,
            lastValues
        };
        const row = await ctx.db.databases.updateAlert(input.alertId, ctx.workspaceId, {
            enabled: input.enabled,
            combinator: input.combinator,
            content: await cipher.encrypt(JSON.stringify(stored))
        });
        if (!row) throw new FeatureError('not_found', 'Alerte introuvable');
        return { alert: await toAlert(cipher, row) };
    }
});

export const databaseAlertRemoveFeature: FeatureDefinition<
    typeof databaseAlertRemove.command,
    typeof databaseAlertRemove.input,
    typeof databaseAlertRemove.output
> = defineFeature({
    ...databaseAlertRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const ok = await ctx.db.databases.removeAlert(input.alertId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Alerte introuvable');
        return { alertId: input.alertId };
    }
});

/**
 * Évalue des conditions tout de suite, sans rien enregistrer ni notifier.
 *
 * Prend les conditions **en entrée** plutôt qu'un identifiant d'alerte : c'est
 * ce qui permet d'essayer une condition en cours d'écriture, avant même de
 * l'avoir enregistrée.
 */
export const databaseAlertTestFeature: FeatureDefinition<
    typeof databaseAlertTest.command,
    typeof databaseAlertTest.input,
    typeof databaseAlertTest.output
> = defineFeature({
    ...databaseAlertTest,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadDatabase(ctx, input.databaseId);
        const started = Date.now();
        const outcomes = await withSession(ctx, input.databaseId, (s) => runConditions(s, input.conditions));
        return {
            firing: isFiring(input.conditions, outcomes, input.combinator),
            values: outcomes.map((o) => o.value),
            errors: outcomes.map((o) => o.error),
            elapsedMs: Date.now() - started
        };
    }
});

export const databaseAlertFeatures = [
    databaseAlertListFeature,
    databaseAlertAddFeature,
    databaseAlertUpdateFeature,
    databaseAlertRemoveFeature,
    databaseAlertTestFeature
];
