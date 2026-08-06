import { homeLayoutSchema, themeStateSchema, workspaceActivate, workspaceSetFavorite } from 'deveye-types';
import type { HomeLayout, ThemeStateDTO } from 'deveye-types';
import { permissionsFor } from '../_access';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/**
 * Bascule vers un espace : renvoie son apparence et sa disposition d'accueil.
 *
 * L'espace visé est celui de l'enveloppe, et le dispatcheur a déjà vérifié
 * l'appartenance — le handler n'a donc plus qu'à servir les deux blobs.
 *
 * Une commande dédiée plutôt qu'un `/api/auth/me` : cette route recalcule
 * l'espace actif à partir du favori du compte et renverrait l'apparence de
 * l'espace qu'*elle* choisit, écrasant au passage la bascule demandée.
 */
export const workspaceActivateFeature: FeatureDefinition<
    typeof workspaceActivate.command,
    typeof workspaceActivate.input,
    typeof workspaceActivate.output
> = defineFeature({
    ...workspaceActivate,
    handler: async (ctx) => {
        const row = await ctx.db.workspaces.findById(ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Espace introuvable');
        return {
            theme: parseJson(row.theme, themeStateSchema) as ThemeStateDTO | null,
            homeLayout: parseJson(row.home_layout, homeLayoutSchema) as HomeLayout | null,
            permissions: await permissionsFor(ctx.db, ctx.userId, row)
        };
    }
});

/**
 * Définit l'espace favori, chargé en premier à la connexion.
 *
 * L'appartenance est vérifiée : pointer un espace qu'on ne fréquente pas
 * bloquerait la connexion suivante. `null` efface le favori et ramène à
 * l'espace personnel.
 */
export const workspaceSetFavoriteFeature: FeatureDefinition<
    typeof workspaceSetFavorite.command,
    typeof workspaceSetFavorite.input,
    typeof workspaceSetFavorite.output
> = defineFeature({
    ...workspaceSetFavorite,
    mutates: true,
    // Préférence de compte : viser un espace partagé dans l'enveloppe ne doit pas
    // changer la cible de l'écriture, qui est toujours la ligne `users`.
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        if (input.workspaceId !== null && !(await ctx.db.workspaceMembers.isMember(ctx.userId, input.workspaceId))) {
            throw new FeatureError('forbidden', 'Vous n’êtes pas membre de cet espace');
        }
        await ctx.db.users.setDefaultWorkspace(ctx.userId, input.workspaceId);
        ctx.audit({
            action: 'workspace.setFavorite',
            level: 'debug',
            description: input.workspaceId === null ? 'Espace favori effacé' : 'Espace favori défini',
            metadata: { favoriteWorkspaceId: input.workspaceId }
        });
        return { workspaceId: input.workspaceId };
    }
});

/** Décode une colonne JSON, en tolérant un contenu devenu invalide. */
function parseJson<T>(raw: string | null, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }) {
    if (!raw) return null;
    try {
        const parsed = schema.safeParse(JSON.parse(raw));
        return parsed.success ? (parsed.data ?? null) : null;
    } catch {
        return null;
    }
}
