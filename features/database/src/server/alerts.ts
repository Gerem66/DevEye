import {
    databaseAlertAdd,
    databaseAlertList,
    databaseAlertRemove,
    databaseAlertTest,
    databaseAlertUpdate
} from '../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { withSession } from './probe';
import { isFiring, runConditions } from './rules';
import { loadDatabase, toAlert, type Ctx, type StoredAlert } from './_shared';

/**
 * Les alertes d'une base. Évaluées par le relevé périodique seulement (inertes
 * sur une base au repos) ; `database.alertTest` évalue à la demande, sans notifier.
 */

export const databaseAlertFeatures = [
    defineSdkFeature({
        ...databaseAlertList,
        handler: async (ctx: Ctx, input) => {
            await loadDatabase(ctx, input.databaseId);
            const cipher = ctx.cipher();
            const rows = await ctx.repo.listAlerts(input.databaseId, ctx.workspaceId);
            return { alerts: await Promise.all(rows.map((row) => toAlert(cipher, row))) };
        }
    }),
    defineSdkFeature({
        ...databaseAlertAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Domicile seulement : une alerte posée d'une fenêtre serait scellée
            // sous la clé d'ici, que le relevé du domicile ne lit pas.
            const home = await loadDatabase(ctx, input.databaseId);
            if (home.workspace_id !== ctx.workspaceId) {
                throw new FeatureError(
                    'forbidden',
                    'Cette base appartient à un autre espace : ses alertes se règlent depuis là-bas.'
                );
            }
            const cipher = ctx.cipher();
            const stored: StoredAlert = {
                name: input.name.trim(),
                conditions: input.conditions,
                message: input.message,
                lastValues: []
            };
            const row = await ctx.repo.createAlert({
                databaseId: input.databaseId,
                workspaceId: ctx.workspaceId,
                enabled: input.enabled,
                combinator: input.combinator,
                content: await cipher.encrypt(JSON.stringify(stored))
            });
            return { alert: await toAlert(cipher, row) };
        }
    }),
    defineSdkFeature({
        ...databaseAlertUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const cipher = ctx.cipher();
            const existing = await ctx.repo.findAlert(input.alertId, ctx.workspaceId);
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
            const row = await ctx.repo.updateAlert(input.alertId, ctx.workspaceId, {
                enabled: input.enabled,
                combinator: input.combinator,
                content: await cipher.encrypt(JSON.stringify(stored))
            });
            if (!row) throw new FeatureError('not_found', 'Alerte introuvable');
            return { alert: await toAlert(cipher, row) };
        }
    }),
    defineSdkFeature({
        ...databaseAlertRemove,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const ok = await ctx.repo.removeAlert(input.alertId, ctx.workspaceId);
            if (!ok) throw new FeatureError('not_found', 'Alerte introuvable');
            return { alertId: input.alertId };
        }
    }),
    /** Prend les conditions en entrée : une condition s'essaie avant d'être enregistrée. */
    defineSdkFeature({
        ...databaseAlertTest,
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => {
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
    })
];
