import { userSetTheme } from 'deveye-types';
import { defineFeature, type FeatureDefinition } from '../_define';

/**
 * Apparence de l'**espace**, pas du compte : la cible est `ctx.workspaceId`, et
 * ce que l'on change ici, tous les membres le voient. D'où la capacité — le
 * propriétaire la possède d'office, donc l'espace personnel n'est jamais gêné.
 *
 * Le préfixe `user` est un reste de l'époque où le thème appartenait au compte ;
 * le renommer coûterait une migration de protocole pour rien. Mais il ne doit
 * surtout pas décider du sujet diffusé : `mutates: true` aurait déduit `account`
 * du préfixe, et `account` ne sort jamais de l'espace personnel — l'apparence
 * n'aurait alors changé que pour les autres onglets de son auteur. D'où le sujet
 * explicite : c'est l'accueil de l'espace qui bouge, pour tous ses membres.
 */
export const userSetThemeFeature: FeatureDefinition<
    typeof userSetTheme.command,
    typeof userSetTheme.input,
    typeof userSetTheme.output
> = defineFeature({
    ...userSetTheme,
    mutates: ['home'],
    access: { capabilities: ['workspace.appearance'] },
    handler: async (ctx, input) => {
        await ctx.db.workspaces.setTheme(ctx.workspaceId, JSON.stringify(input));
        ctx.audit({ action: 'user.setTheme', level: 'debug', description: 'Apparence modifiée' });
        return { ok: true };
    }
});
