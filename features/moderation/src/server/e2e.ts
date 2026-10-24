import type { FeatureE2eEntry } from '@deveye/types/sdk/server';

import type { Rule } from '../contracts/domain';
import type { ModerationRepo } from './repo';

const PATTERNS = ['*.essai-de-bout-en-bout', 'essai-e2e-?.tmp'];

/** Deux motifs de nom posés d'un coup, relus dans la liste, puis retirés. */
export const moderationE2e: FeatureE2eEntry<ModerationRepo> = {
    scenarios: [
        {
            id: 'rules',
            label: 'Poser et retirer des règles',
            steps: [
                {
                    label: 'Ajouter deux motifs de nom',
                    run: async (ctx) => {
                        const { added } = await ctx.send<{ added: number }>('x-moderation.rulesAdd', {
                            rules: {
                                kind: 'name',
                                text: PATTERNS.join('\n'),
                                reason: 'other',
                                label: 'Scénario de bout en bout',
                                exposure: 'public'
                            }
                        });
                        const { rules } = await ctx.send<{ rules: Rule[] }>('x-moderation.rules', {});
                        const ids = rules.filter((rule) => PATTERNS.includes(rule.pattern)).map((rule) => rule.id);
                        ctx.state.set('ruleIds', ids);
                        ctx.defer('Retirer les règles', async () => {
                            for (const ruleId of ids) {
                                try {
                                    await ctx.send('x-moderation.ruleRemove', { ruleId });
                                } catch (e) {
                                    if ((e as { code?: string }).code !== 'not_found') throw e;
                                }
                            }
                        });
                        if (ids.length !== PATTERNS.length) {
                            throw new Error(`${ids.length} règle(s) relue(s) sur ${PATTERNS.length} posée(s)`);
                        }
                        return `${added} règle(s) ajoutée(s)`;
                    }
                },
                {
                    label: 'Les retirer',
                    run: async (ctx) => {
                        const ids = ctx.state.get('ruleIds') as number[];
                        for (const ruleId of ids) await ctx.send('x-moderation.ruleRemove', { ruleId });
                        const { rules } = await ctx.send<{ rules: Rule[] }>('x-moderation.rules', {});
                        if (rules.some((rule) => ids.includes(rule.id))) {
                            throw new Error('Une règle retirée figure encore dans la liste');
                        }
                    }
                }
            ]
        }
    ]
};
