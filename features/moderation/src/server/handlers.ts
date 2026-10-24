import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { moderationHits, moderationRuleRemove, moderationRules, moderationRulesAdd } from '../contracts/commands';
import { ruleLabelOf } from '../contracts/domain';
import { hitView, ruleView, type Ctx } from './_shared';
import { parseFingerprints, parseNamePatterns } from './rules';
import { moderation } from './service';

/**
 * Les commandes du module, toutes de modération : lire et tenir les règles,
 * relire ce qu'elles ont arrêté. Un modérateur voit le contenu des détections
 * sans savoir d'où elles viennent ; l'espace et le compte ne sortent que vers
 * un administrateur.
 */

const MODERATION = { scope: 'account', moderation: true } as const;

function requireService() {
    const service = moderation();
    if (service === null) throw new FeatureError('internal', 'Le service de modération ne tourne pas.');
    return service;
}

/** Les motifs d'un texte, selon le genre : lus avec tolérance pour des empreintes, à la lettre pour des noms. */
function patternsOf(kind: 'fingerprint' | 'name', text: string): { patterns: string[]; ignored: number } {
    if (kind === 'fingerprint') {
        const { fingerprints, ignored } = parseFingerprints(text);
        return { patterns: fingerprints, ignored };
    }
    const parsed = parseNamePatterns(text);
    if (parsed.problem !== null) {
        throw new FeatureError('validation', `Ligne ${parsed.problem.line} : ${parsed.problem.message}`);
    }
    return parsed;
}

export const moderationHandlers = [
    defineSdkFeature({
        ...moderationRules,
        access: MODERATION,
        handler: async (ctx: Ctx) => {
            const [rows, feed] = await Promise.all([ctx.repo.listRules(), requireService().feedStatus()]);
            return { rules: rows.map(ruleView), feed };
        }
    }),

    defineSdkFeature({
        ...moderationRulesAdd,
        access: MODERATION,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const { rules } = input;
            const { patterns, ignored } = patternsOf(rules.kind, rules.text);
            if (patterns.length === 0) {
                throw new FeatureError(
                    'validation',
                    rules.kind === 'fingerprint'
                        ? 'Aucune empreinte SHA-256 dans ce texte.'
                        : 'Aucun motif de nom dans ce texte.'
                );
            }
            const label = ruleLabelOf(rules.label, rules.reason);
            const added = await ctx.repo.insertRules(
                patterns.map((pattern) => ({
                    kind: rules.kind,
                    pattern,
                    reason: rules.reason,
                    label,
                    exposure: rules.exposure,
                    source: 'manual' as const,
                    created_by: ctx.userId
                }))
            );
            requireService().rulesChanged();
            ctx.audit({
                action: 'moderation.rulesAdd',
                description: `${added} règle(s) de modération ajoutée(s) (${rules.kind === 'fingerprint' ? 'empreintes' : 'noms de fichiers'}).`,
                level: 'warning',
                metadata: {
                    added,
                    read: patterns.length,
                    kind: rules.kind,
                    reason: rules.reason,
                    exposure: rules.exposure
                }
            });
            return { added, ignored: ignored + (patterns.length - added) };
        }
    }),

    defineSdkFeature({
        ...moderationRuleRemove,
        access: MODERATION,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.findRule(input.ruleId);
            if (row === null) throw new FeatureError('not_found', 'Cette règle n’existe plus.');
            await ctx.repo.deleteRule(row.id);
            requireService().rulesChanged();
            // Le motif reste dans la table des règles, jamais dans le journal : il
            // ne doit pas sortir avec l'activité d'un compte.
            ctx.audit({
                action: 'moderation.ruleRemove',
                description: `Règle de modération retirée (${row.kind === 'fingerprint' ? 'empreinte' : 'nom de fichier'}).`,
                level: 'warning',
                metadata: { ruleId: row.id, kind: row.kind, source: row.source }
            });
            return { ok: true as const };
        }
    }),

    defineSdkFeature({
        ...moderationHits,
        access: MODERATION,
        handler: async (ctx: Ctx, input) => {
            const rows = await ctx.repo.listHits(input.limit);
            return { hits: rows.map((row) => hitView(ctx.keys, row, ctx.isAdmin)) };
        }
    })
];
