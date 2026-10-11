import type { FeatureE2eEntry, SdkOrigins } from '@deveye/types/sdk/server';

import { SHORTLINKS_PATH, type Shortlink } from '../contracts/domain';
import { redirectHost, SHORT_HOST } from './_shared';
import type { ShortlinksRepo } from './repo';

const TARGET = 'https://example.com/arrivee';
const PASSWORD = 'essai-de-bout-en-bout';

const linkOf = (ctx: { state: Map<string, unknown> }) => ctx.state.get('link') as Shortlink;

/** Le seul nom de DevEye sous lequel un lien redirige : la requête part vers l'écouteur, sous ce nom. */
const asVisitor = (ctx: { origins: SdkOrigins }, headers: Record<string, string> = {}) => ({
    host: redirectHost(ctx.origins),
    ...headers
});

/**
 * Un lien de ce serveur même, suivi comme le ferait un visiteur : la
 * redirection et ses paramètres de campagne, l'aperçu, le mot de passe, la
 * visite comptée, et le domaine court quand il est posé.
 */
export const shortlinksE2e: FeatureE2eEntry<ShortlinksRepo> = {
    scenarios: [
        {
            id: 'redirect',
            label: 'Raccourcir un lien et le suivre',
            steps: [
                {
                    label: 'Créer le lien',
                    run: async (ctx) => {
                        const { link } = await ctx.send<{ link: Shortlink }>('shortlinks.add', {
                            link: { title: 'Essai de bout en bout', target: TARGET, domainId: null, slug: null }
                        });
                        ctx.state.set('link', link);
                        ctx.defer('Supprimer le lien', async () => {
                            try {
                                await ctx.send('shortlinks.remove', { id: link.id });
                            } catch (e) {
                                if ((e as { code?: string }).code !== 'not_found') throw e;
                            }
                        });
                        await ctx.send('shortlinks.updateCampaign', {
                            id: link.id,
                            utm: { source: 'essai', medium: '', campaign: 'bout-en-bout', term: '', content: '' }
                        });
                        return link.shortUrl;
                    }
                },
                {
                    label: 'Suivre le lien',
                    run: async (ctx) => {
                        const reply = await ctx.fetch(`${SHORTLINKS_PATH}/${linkOf(ctx).code}`, {
                            headers: asVisitor(ctx)
                        });
                        const location = reply.headers.location ?? '';
                        if (reply.status !== 302) throw new Error(`HTTP ${reply.status} au lieu d’une redirection`);
                        if (!location.startsWith(TARGET) || !location.includes('utm_source=essai')) {
                            throw new Error(`Redirigé vers ${location || 'rien'}`);
                        }
                        return location;
                    }
                },
                {
                    label: 'Voir l’aperçu',
                    run: async (ctx) => {
                        const reply = await ctx.fetch(`${SHORTLINKS_PATH}/${linkOf(ctx).code}+`, {
                            headers: asVisitor(ctx)
                        });
                        if (reply.status !== 200 || !reply.body.includes('example.com')) {
                            throw new Error(`Aperçu en HTTP ${reply.status}, sans la destination`);
                        }
                    }
                },
                {
                    label: 'Protéger par un mot de passe et le saisir',
                    run: async (ctx) => {
                        const link = linkOf(ctx);
                        await ctx.send('shortlinks.updateAccess', {
                            id: link.id,
                            access: { password: { mode: 'set', value: PASSWORD }, expiresAt: null, maxVisits: null }
                        });
                        const asked = await ctx.fetch(`${SHORTLINKS_PATH}/${link.code}`, { headers: asVisitor(ctx) });
                        if (asked.status !== 401)
                            throw new Error(`HTTP ${asked.status} au lieu de la page du mot de passe`);
                        const wrong = await ctx.fetch(`${SHORTLINKS_PATH}/${link.code}/deverrouiller`, {
                            method: 'POST',
                            headers: asVisitor(ctx, { 'content-type': 'application/x-www-form-urlencoded' }),
                            body: 'password=faux'
                        });
                        if (wrong.status !== 403) throw new Error(`Un mauvais mot de passe rend HTTP ${wrong.status}`);
                        const right = await ctx.fetch(`${SHORTLINKS_PATH}/${link.code}/deverrouiller`, {
                            method: 'POST',
                            headers: asVisitor(ctx, { 'content-type': 'application/x-www-form-urlencoded' }),
                            body: `password=${encodeURIComponent(PASSWORD)}`
                        });
                        if (right.status !== 303 || !(right.headers.location ?? '').startsWith(TARGET)) {
                            throw new Error(`Le bon mot de passe rend HTTP ${right.status}`);
                        }
                    }
                },
                {
                    label: 'Compter la visite',
                    run: async (ctx) => {
                        const link = await ctx.waitFor(
                            async () => {
                                const { link: fresh } = await ctx.send<{ link: Shortlink }>('shortlinks.get', {
                                    id: linkOf(ctx).id
                                });
                                return fresh.visits > 0 ? fresh : null;
                            },
                            { timeoutMs: 15_000, intervalMs: 1_000, what: 'La visite dans les chiffres du lien' }
                        );
                        return `${link.visits} visite, ${link.clicks} ouvertures`;
                    }
                },
                {
                    label: 'Suivre le lien sur le domaine court',
                    run: async (ctx) => {
                        if (SHORT_HOST === null)
                            return 'Aucun domaine court posé (SHORTLINKS_ORIGIN) : étape sans objet';
                        await ctx.send('shortlinks.updateAccess', {
                            id: linkOf(ctx).id,
                            access: { password: { mode: 'clear' }, expiresAt: null, maxVisits: null }
                        });
                        const reply = await ctx.fetch(`/${linkOf(ctx).code}`, { headers: { host: SHORT_HOST } });
                        if (reply.status !== 302 || !(reply.headers.location ?? '').startsWith(TARGET)) {
                            throw new Error(`HTTP ${reply.status} sous ${SHORT_HOST}`);
                        }
                        return SHORT_HOST;
                    }
                }
            ]
        }
    ]
};
