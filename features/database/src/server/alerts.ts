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
            // Domicile seulement, comme `database.update` : l'alerte serait
            // rangée dans l'espace d'ICI et scellée sous sa clé, là où le relevé
            // n'évalue que les alertes du domicile, lisibles sous la sienne. Une
            // alerte posée d'une fenêtre serait donc inerte et invisible de la
            // fiche ; le refus explicite vaut mieux.
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
    /**
     * Évalue des conditions tout de suite, sans rien enregistrer ni notifier.
     *
     * Prend les conditions **en entrée** plutôt qu'un identifiant d'alerte : c'est
     * ce qui permet d'essayer une condition en cours d'écriture, avant même de
     * l'avoir enregistrée.
     */
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
