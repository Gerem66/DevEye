import type { Launcher } from '@/Services/debug/runs';
import { FeatureError, type FeatureContext } from '../_define';

/** L'administrateur qui lance un essai, tel que l'historique le nomme. */
export async function launcherOf(ctx: FeatureContext): Promise<Launcher> {
    const row = await ctx.db.users.findById(ctx.userId);
    if (!row) throw new FeatureError('not_found', 'Compte introuvable');
    return { id: row.id, username: row.username };
}
