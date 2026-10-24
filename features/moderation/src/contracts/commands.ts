import { z } from 'zod';

import { feedStatusSchema, hitSchema, HITS_LIMIT_MAX, rulesDraftSchema, ruleSchema } from './domain';

/** Les commandes du module, toutes de modération : un modérateur ou un administrateur, sur son compte. */

const ok = z.object({ ok: z.literal(true) });
const id = z.number().int().positive();

export const moderationRules = {
    command: 'x-moderation.rules' as const,
    input: z.object({}),
    output: z.object({
        /** Les règles lisibles une à une : tout sauf la liste externe, résumée à part. */
        rules: z.array(ruleSchema),
        feed: feedStatusSchema
    })
};

/**
 * Des règles d'un même genre, un motif par ligne, qui partagent motif, libellé
 * et portée. Une empreinte qui n'en est pas une (un commentaire, une colonne
 * de tableur) est ignorée, comme un motif déjà posé ; un motif de nom invalide
 * refuse tout l'ajout, en nommant sa ligne.
 */
export const moderationRulesAdd = {
    command: 'x-moderation.rulesAdd' as const,
    input: z.object({ rules: rulesDraftSchema }),
    output: z.object({ added: z.number().int(), ignored: z.number().int() })
};

export const moderationRuleRemove = {
    command: 'x-moderation.ruleRemove' as const,
    input: z.object({ ruleId: id }),
    output: ok
};

export const moderationHits = {
    command: 'x-moderation.hits' as const,
    input: z.object({ limit: z.number().int().min(1).max(HITS_LIMIT_MAX).default(100) }),
    output: z.object({ hits: z.array(hitSchema) })
};

export const moderationCommands = [moderationRules, moderationRulesAdd, moderationRuleRemove, moderationHits] as const;
