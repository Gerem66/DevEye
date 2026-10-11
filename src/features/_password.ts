import { verifyPassword } from '@/auth/argon';
import { clearAttempts, guardAttempt, recordFailedAttempt } from '@/Services/attempts';
import { FeatureError, type FeatureContext } from './_define';

/**
 * Le mot de passe du compte, sous le compteur des mots de passe, pour un geste
 * qu'une session volée ne doit pas pouvoir faire seule (baisser une protection,
 * en poser une qu'elle contrôlerait). Un échec est audité sous `failedAction`.
 */
export async function assertAccountPassword(
    ctx: FeatureContext,
    password: string,
    failedAction: string
): Promise<void> {
    const key = String(ctx.userId);
    guardAttempt('password', key);
    const user = await ctx.db.users.findById(ctx.userId);
    if (!user?.password_hash || !(await verifyPassword(user.password_hash, password))) {
        recordFailedAttempt('password', key);
        ctx.audit({ action: failedAction, level: 'warning', description: 'Mot de passe incorrect' });
        throw new FeatureError('auth_invalid', 'Mot de passe incorrect');
    }
    clearAttempts('password', key);
}
