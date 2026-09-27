import { check, expectRefusal, type E2eContext, type E2eScenario } from '../scenario';

const ROLE = { name: 'Essai', color: '#22d3ee', features: [] };

const workspaceOf = (ctx: E2eContext): number => ctx.state.get('workspaceId') as number;

/** Un espace à deux : l'invitation, un rôle qui refuse puis accorde, le départ du membre, la suppression. */
export const sharedWorkspace: E2eScenario = {
    id: 'core.sharing',
    label: 'Espace partagé à deux',
    sourceLabel: 'DevEye',
    accounts: 2,
    steps: [
        {
            label: 'Créer un espace partagé',
            run: async (ctx) => {
                const [owner] = ctx.accounts;
                const { workspace } = await owner.client.send<{ workspace: { id: number } }>('workspace.add', {
                    name: 'Essai de bout en bout'
                });
                ctx.state.set('workspaceId', workspace.id);
                ctx.ledger.defer('Supprimer l’espace partagé', async () => {
                    try {
                        await owner.client.send('workspace.delete', { workspaceId: workspace.id });
                    } catch (e) {
                        // Déjà supprimé par la dernière étape.
                        if ((e as { code?: string }).code !== 'not_found') throw e;
                    }
                });
                return `Espace ${workspace.id}`;
            }
        },
        {
            label: 'Inviter le second compte',
            run: async (ctx) => {
                const [owner, member] = ctx.accounts;
                await owner.client.send(
                    'workspace.addMember',
                    { email: member.email },
                    { workspaceId: workspaceOf(ctx) }
                );
                const me = await member.client.api<{ workspaces: { id: number }[] }>('/api/auth/me');
                check(
                    me.workspaces.some((w) => w.id === workspaceOf(ctx)),
                    'Le membre ne voit pas l’espace qui l’a invité'
                );
            }
        },
        {
            label: 'Lui donner un rôle sans aucun droit',
            run: async (ctx) => {
                const [owner, member] = ctx.accounts;
                const ws = { workspaceId: workspaceOf(ctx) };
                const { role } = await owner.client.send<{ role: { id: number } }>(
                    'workspace.roleCreate',
                    { ...ROLE, capabilities: [] },
                    ws
                );
                ctx.state.set('roleId', role.id);
                await owner.client.send('workspace.assignRole', { userId: member.userId, roleId: role.id }, ws);
                await expectRefusal(member.client.send('workspace.rename', { name: 'Refusé' }, ws), 'forbidden');
                return 'Renommer l’espace lui est refusé';
            }
        },
        {
            label: 'Lui accorder le droit de gérer l’espace',
            run: async (ctx) => {
                const [owner, member] = ctx.accounts;
                const ws = { workspaceId: workspaceOf(ctx) };
                await owner.client.send(
                    'workspace.roleUpdate',
                    { ...ROLE, roleId: ctx.state.get('roleId'), capabilities: ['workspace.manage'] },
                    ws
                );
                const name = 'Renommé par le membre';
                const { workspace } = await member.client.send<{ workspace: { name: string } }>(
                    'workspace.rename',
                    { name },
                    ws
                );
                check(workspace.name === name, 'Le renommage n’a pas pris');
                return 'Il renomme l’espace';
            }
        },
        {
            label: 'Retirer le membre',
            run: async (ctx) => {
                const [owner, member] = ctx.accounts;
                const ws = { workspaceId: workspaceOf(ctx) };
                await owner.client.send('workspace.removeMember', { userId: member.userId }, ws);
                try {
                    await member.client.send('workspace.activate', {}, ws);
                } catch (e) {
                    const code = (e as { code?: string }).code;
                    check(
                        code === 'forbidden' || code === 'not_found',
                        `Refus attendu, reçu ${code ?? (e as Error).message}`
                    );
                    return 'L’espace lui est fermé';
                }
                throw new Error('L’ancien membre entre encore dans l’espace');
            }
        },
        {
            label: 'Supprimer l’espace',
            run: async (ctx) => {
                const [owner] = ctx.accounts;
                await owner.client.send('workspace.delete', { workspaceId: workspaceOf(ctx) });
                const me = await owner.client.api<{ workspaces: { id: number }[] }>('/api/auth/me');
                check(!me.workspaces.some((w) => w.id === workspaceOf(ctx)), 'L’espace est encore listé');
            }
        }
    ]
};
