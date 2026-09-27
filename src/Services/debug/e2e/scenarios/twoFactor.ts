import { totpCode } from '@/Services/Totp';
import { check, type E2eContext, type E2eScenario } from '../scenario';

const STEP_MS = 30_000;

interface Setup {
    secret: string;
    backupCodes: string[];
}

const setupOf = (ctx: E2eContext): Setup => ctx.state.get('setup') as Setup;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(new Error('Essai arrêté'));
            },
            { once: true }
        );
    });
}

/** La double authentification : activée par un code, exigée à la connexion, coupée par un code de secours. */
export const twoFactor: E2eScenario = {
    id: 'core.twoFactor',
    label: 'Double authentification',
    sourceLabel: 'DevEye',
    accounts: 1,
    steps: [
        {
            label: 'L’activer avec un code',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const { setup } = await account.client.send<{ setup: Setup }>('twofa.setup', {});
                check(setup.backupCodes.length > 0, 'Aucun code de secours fourni');
                ctx.state.set('setup', setup);
                const { status } = await account.client.send<{ status: { enabled: boolean } }>('twofa.enable', {
                    code: totpCode(setup.secret)
                });
                check(status.enabled, 'La double authentification ne s’est pas activée');
                ctx.state.set('enabledAt', Date.now());
            }
        },
        {
            label: 'Se reconnecter : un code est exigé',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                account.client.close();
                await account.client.api('/api/auth/logout', {});
                const login = await account.client.api<{ twoFactorRequired: boolean }>('/api/auth/login', {
                    username: account.username,
                    password: account.password
                });
                check(login.twoFactorRequired, 'La connexion n’a pas demandé de code');
            }
        },
        {
            label: 'Donner le code du pas suivant',
            // Un code déjà accepté ne l'est plus jamais : il faut attendre le pas suivant, 30 s au plus.
            timeoutMs: 45_000,
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const enabledStep = Math.floor((ctx.state.get('enabledAt') as number) / STEP_MS);
                const wait = (enabledStep + 1) * STEP_MS - Date.now() + 500;
                if (wait > 0) await sleep(wait, ctx.signal);
                await account.client.api('/api/auth/2fa/challenge', { code: totpCode(setupOf(ctx).secret) });
                await account.client.connect();
                return wait > 0 ? `Après ${Math.round(wait / 1000)} s d’attente` : undefined;
            }
        },
        {
            label: 'La couper avec un code de secours',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const { status } = await account.client.send<{ status: { enabled: boolean } }>('twofa.disable', {
                    code: setupOf(ctx).backupCodes[0]
                });
                check(!status.enabled, 'La double authentification est restée active');
            }
        }
    ]
};
