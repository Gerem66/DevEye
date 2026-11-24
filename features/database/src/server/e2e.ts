import type { FeatureE2eEntry, SdkE2eContext } from '@deveye/types/sdk/server';

import type { Database } from '../contracts/domain';
import type { DatabaseRepo } from './repo';

type Ctx = SdkE2eContext<DatabaseRepo>;

const NAME = 'Essai des noms';

/** Une fiche que rien ne relève : aucune connexion ne part vers cette adresse. */
const draft = (name: string) => ({
    engine: 'mysql' as const,
    name,
    host: 'db.essai.invalid',
    port: 3306,
    database: 'essai',
    username: 'essai',
    password: 'secret',
    access: { kind: 'direct' as const, host: '', port: null, username: '', auth: 'password' as const, deviceId: null },
    monitorEnabled: false,
    intervalSeconds: 300,
    autoLoadTables: false
});

async function add(ctx: Ctx, name: string, workspaceId?: number): Promise<number> {
    const opts = workspaceId === undefined ? undefined : { workspaceId };
    const { database } = await ctx.send<{ database: Database }>('database.add', draft(name), opts);
    ctx.defer(`Supprimer la base ${database.id}`, async () => {
        // Déplacée ou déjà retirée par une étape : rien à défaire.
        await ctx.send('database.remove', { databaseId: database.id }, opts).catch(() => undefined);
    });
    return database.id;
}

/** Le code du refus, ou `null` quand le geste est passé. */
async function refusal(run: () => Promise<unknown>): Promise<string | null> {
    try {
        await run();
        return null;
    } catch (e) {
        return (e as { code?: string }).code ?? 'inconnu';
    }
}

/** La copie d'une base vers `to`, comme le navigateur la mène. Rend l'id de la copie. */
async function copyTo(ctx: Ctx, databaseId: number, to: number): Promise<number> {
    const manifest = await ctx.send<{ exportId: string; bytes: number; chunks: number; sha256: string }>(
        'share.copyExport',
        { feature: 'database', itemId: String(databaseId) }
    );
    const chunks: string[] = [];
    for (let index = 0; index < manifest.chunks; index++) {
        chunks.push((await ctx.send<{ data: string }>('share.copyChunk', { exportId: manifest.exportId, index })).data);
    }
    const { importId } = await ctx.send<{ importId: string }>(
        'share.copyBegin',
        { feature: 'database', bytes: manifest.bytes, chunks: manifest.chunks, sha256: manifest.sha256 },
        { workspaceId: to }
    );
    for (const [index, data] of chunks.entries()) {
        await ctx.send('share.copyPut', { importId, index, data }, { workspaceId: to });
    }
    const { itemId } = await ctx.send<{ itemId: string }>(
        'share.copyCommit',
        { importId, feature: 'database' },
        { workspaceId: to }
    );
    return Number(itemId);
}

const there = (ctx: Ctx): number => ctx.state.get('ws') as number;
const here = (ctx: Ctx): number => ctx.account.workspaceId;
const baseOf = (ctx: Ctx): number => ctx.state.get('base') as number;

/**
 * Le nom d'une base est unique dans son espace par un condensé lié à cet
 * espace : ce parcours le suit à travers la saisie, la copie et le déplacement,
 * les trois endroits où il se calcule. Jamais plus de deux bases à la fois :
 * c'est ce qu'admet l'offre d'un compte d'essai.
 */
export const databaseE2e: FeatureE2eEntry<DatabaseRepo> = {
    scenarios: [
        {
            id: 'names',
            label: 'Le nom d’une base, d’un espace à l’autre',
            steps: [
                {
                    label: 'Une base, et un second espace',
                    run: async (ctx) => {
                        ctx.state.set('base', await add(ctx, NAME));
                        const { workspace } = await ctx.send<{ workspace: { id: number } }>('workspace.add', {
                            name: 'Essai des bases'
                        });
                        ctx.state.set('ws', workspace.id);
                        ctx.defer('Supprimer le second espace', async () => {
                            await ctx.send('workspace.delete', { workspaceId: workspace.id });
                        });
                    }
                },
                {
                    label: 'Le même nom est refusé ici, à la casse près, et libre là-bas',
                    run: async (ctx) => {
                        const clash = await refusal(() => ctx.send('database.add', draft(` ${NAME.toUpperCase()} `)));
                        if (clash !== 'conflict') throw new Error(`Attendu un conflit, reçu ${clash}`);
                        ctx.state.set('twin', await add(ctx, NAME, there(ctx)));

                        const [mine, twin] = await Promise.all([
                            ctx.repo.findVisible(baseOf(ctx), here(ctx)),
                            ctx.repo.findVisible(ctx.state.get('twin') as number, there(ctx))
                        ]);
                        if (!mine || !twin) throw new Error('Une des deux bases ne se relit pas');
                        if (!/^[0-9a-f]{32}$/.test(mine.name_ref))
                            throw new Error('Le condensé du nom n’est pas à clé');
                        if (mine.name_ref === twin.name_ref) {
                            throw new Error('Le même nom porte le même condensé dans deux espaces');
                        }
                    }
                },
                {
                    label: 'La déplacer là-bas est refusé tant que le nom y est pris',
                    run: async (ctx) => {
                        const moved = await refusal(() =>
                            ctx.send('share.move', {
                                feature: 'database',
                                itemId: String(baseOf(ctx)),
                                workspaceId: there(ctx)
                            })
                        );
                        if (moved !== 'validation') throw new Error(`Attendu un refus, reçu ${moved}`);
                        if (!(await ctx.repo.findVisible(baseOf(ctx), here(ctx)))) {
                            throw new Error('La base a quitté son espace malgré le refus');
                        }
                    }
                },
                {
                    label: 'Le nom libéré là-bas, la copie arrive et le reprend',
                    run: async (ctx) => {
                        await ctx.send(
                            'database.remove',
                            { databaseId: ctx.state.get('twin') as number },
                            { workspaceId: there(ctx) }
                        );
                        const copy = await copyTo(ctx, baseOf(ctx), there(ctx));
                        ctx.state.set('copy', copy);
                        ctx.defer('Supprimer la copie', async () => {
                            await ctx
                                .send('database.remove', { databaseId: copy }, { workspaceId: there(ctx) })
                                .catch(() => undefined);
                        });
                        // Le condensé de la copie est celui que la saisie calcule là-bas : le nom y est pris.
                        const clash = await refusal(() =>
                            ctx.send('database.add', draft(NAME), { workspaceId: there(ctx) })
                        );
                        if (clash !== 'conflict') throw new Error(`La copie ne tient pas son nom (${clash})`);
                    }
                },
                {
                    label: 'La copie retirée, la base se déplace : son nom se libère ici et se prend là-bas',
                    run: async (ctx) => {
                        await ctx.send(
                            'database.remove',
                            { databaseId: ctx.state.get('copy') as number },
                            { workspaceId: there(ctx) }
                        );
                        await ctx.send('share.move', {
                            feature: 'database',
                            itemId: String(baseOf(ctx)),
                            workspaceId: there(ctx)
                        });
                        ctx.defer('Supprimer la base déplacée', async () => {
                            await ctx
                                .send('database.remove', { databaseId: baseOf(ctx) }, { workspaceId: there(ctx) })
                                .catch(() => undefined);
                        });
                        const clash = await refusal(() =>
                            ctx.send('database.add', draft(NAME), { workspaceId: there(ctx) })
                        );
                        if (clash !== 'conflict') throw new Error(`La base déplacée ne tient pas son nom (${clash})`);
                        // Ici, le nom est de nouveau libre.
                        await add(ctx, NAME);
                    }
                }
            ]
        }
    ]
};
