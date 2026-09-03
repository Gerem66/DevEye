import { userSetUsername } from '@deveye/types';
import { notifyAdmins } from '../admin/notify';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * Renomme le compte. `scope: 'account'` comme les autres réglages de compte : le
 * pseudo suit le compte et non l'espace d'où on le change. La diffusion
 * `mutates` vise donc l'espace personnel de l'appelant, où il est seul : c'est
 * `announce` qui porte le nouveau nom là où les autres le lisent.
 */
export const userSetUsernameFeature: FeatureDefinition<
    typeof userSetUsername.command,
    typeof userSetUsername.input,
    typeof userSetUsername.output
> = defineFeature({
    ...userSetUsername,
    mutates: true,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        const username = input.username;
        const before = (await ctx.db.users.findById(ctx.userId))?.username ?? '';
        if (before === username) return { username };

        // L'index UNIQUE de `users.username` tranche en dernier ressort ; ce
        // contrôle est là pour rendre un refus lisible plutôt qu'une erreur SQL.
        if (await ctx.db.users.findByUsername(username)) {
            throw new FeatureError('conflict', `« ${username} » est déjà pris`);
        }

        await ctx.db.users.updateUsername(ctx.userId, username);
        // L'espace personnel porte le nom de son propriétaire depuis
        // l'inscription et rien d'autre ne le renomme : le laisser en arrière
        // figerait l'ancien pseudo dans la bascule d'espaces.
        await ctx.db.workspaces.rename(ctx.workspaceId, username);

        await announce(ctx);
        ctx.audit({
            action: 'user.setUsername',
            level: 'warning',
            description: `Compte renommé : « ${before} » → « ${username} »`
        });
        return { username };
    }
});

/**
 * Le pseudo se lit chez les autres, qui le résolvent depuis leur bundle de
 * session : ses espaces partagés, et la page Utilisateurs des administrateurs.
 * Par compte et non par salle, un membre assis ailleurs ne recevant pas la
 * diffusion de celui-ci.
 */
async function announce(ctx: FeatureContext): Promise<void> {
    const live = ctx.live;
    if (!live) return;

    const shared = (await ctx.db.workspaces.findAccessibleByUser(ctx.userId))
        .filter((w) => w.kind === 'shared')
        .map((w) => w.id);
    for (const member of await ctx.db.workspaceMembers.listByWorkspaceIds(shared)) {
        live.userChanged(member.user_id, member.workspace_id, ['workspace'], null);
    }
    // Les autres onglets de l'intéressé, qui n'a pas forcément d'espace partagé.
    live.userChanged(ctx.userId, ctx.workspaceId, ['workspace'], null);
    await notifyAdmins(ctx.db, live, ctx.workspaceId, ctx.userId);
}
