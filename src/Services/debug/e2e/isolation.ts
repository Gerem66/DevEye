import { randomBytes } from 'node:crypto';
import {
    isolationProbes,
    type FeatureIsolation,
    type SdkFeatureDefinition,
    type SdkIsolationIds,
    type SdkIsolationProbe,
    type SdkIsolationSeedContext
} from '@deveye/types/sdk/server';

import { listenerPortForHost } from '@/features/_sdk/register';
import { maintenance } from '@/Services/maintenance';
import type { TestSession } from './accounts';
import { check, waitFor, type E2eContext, type E2eScenario } from './scenario';

/**
 * Le parcours `<module>.isolation`, bâti sur le bloc que le module déclare
 * (`FeatureIsolation`) : une victime sème dans un espace partagé, un intrus
 * tente chaque sonde depuis toutes les positions qu'un compte peut tenir, et
 * les lectures de la victime ne doivent pas avoir bougé.
 */

type Commands = readonly Pick<SdkFeatureDefinition, 'command' | 'input' | 'access'>[];

export interface Shared {
    workspaceId: number;
    ids: SdkIsolationIds;
    canary: string;
    itemCanary: string;
    baseline: string[];
    roleId: number;
}

const REFUSALS = new Set(['forbidden', 'not_found']);
const ROLE = { name: 'Intrus', color: '#22d3ee', capabilities: [], allFeatures: false };

const shared = (ctx: E2eContext): Shared => ctx.state.get('isolation') as Shared;
const show = ([command, input]: SdkIsolationProbe): string => `${command} ${JSON.stringify(input)}`;

type Outcome = { ok: true; text: string } | { ok: false; code: string; text: string };

async function attempt(who: TestSession, probe: SdkIsolationProbe, workspaceId?: number): Promise<Outcome> {
    try {
        const data = await who.client.send(probe[0], probe[1], workspaceId === undefined ? {} : { workspaceId });
        return { ok: true, text: JSON.stringify(data) ?? '' };
    } catch (e) {
        const error = e as { code?: string; message?: string; details?: unknown };
        return {
            ok: false,
            code: error.code ?? 'aucun',
            text: `${error.message ?? ''} ${JSON.stringify(error.details ?? null)}`
        };
    }
}

/** Les marques de la victime qu'une réponse porte : aucune ne doit sortir vers l'intrus. */
function leaked(text: string, s: Shared): string | null {
    if (text.includes(s.canary)) return 'porte la marque de la victime';
    if (text.includes(s.itemCanary)) return 'porte la marque d’un élément de la victime';
    return null;
}

/**
 * Tout ce que l'intrus tente depuis une position : chaque sonde est refusée
 * (`forbidden` ou `not_found`, pas une autre raison, qui ne prouverait rien),
 * chaque lecture l'est aussi ou ne rend rien de la victime.
 */
export async function allRefused(
    intruder: TestSession,
    s: Shared,
    probes: readonly SdkIsolationProbe[],
    reads: readonly SdkIsolationProbe[],
    lenient: Readonly<Record<string, string>>,
    workspaceId?: number
): Promise<string> {
    const faults: string[] = [];
    for (const probe of probes) {
        const out = await attempt(intruder, probe, workspaceId);
        const leak = leaked(out.text, s);
        if (out.ok) {
            // Une commande indulgente répond sans refuser : seules comptent
            // alors sa réponse et les données de la victime.
            if (lenient[probe[0]] === undefined) faults.push(`${show(probe)} : a réussi`);
        } else if (!REFUSALS.has(out.code)) {
            faults.push(`${show(probe)} : refusée pour une autre raison (${out.code})`);
        }
        if (leak) faults.push(`${show(probe)} : la réponse ${leak}`);
    }
    for (const read of reads) {
        const out = await attempt(intruder, read, workspaceId);
        const leak = leaked(out.text, s);
        if (leak) faults.push(`${show(read)} : la réponse ${leak}`);
        else if (!out.ok && !REFUSALS.has(out.code)) {
            faults.push(`${show(read)} : refusée pour une autre raison (${out.code})`);
        }
    }
    check(faults.length === 0, faults.join('\n'));
    return `${probes.length} sonde(s) et ${reads.length} lecture(s) sans rien de la victime`;
}

/** Une sonde vise-t-elle un élément fermé : un champ de son entrée porte le nom et la valeur de son identifiant. */
export function targets(probe: SdkIsolationProbe, keys: readonly string[], ids: SdkIsolationIds): boolean {
    const input = probe[1];
    if (typeof input !== 'object' || input === null) return false;
    return keys.some((key) => (input as Record<string, unknown>)[key] === ids[key]);
}

export function isolationScenario(
    featureId: string,
    label: string,
    isolation: FeatureIsolation,
    commands: Commands,
    repo: unknown
): E2eScenario {
    const probesOf = (s: Shared): SdkIsolationProbe[] => isolationProbes(commands, isolation, s.ids);
    const itemKeys = isolation.items ?? [];
    const lenient = isolation.lenient ?? {};

    return {
        id: `${featureId}.isolation`,
        label: 'Cloisonnement entre espaces',
        sourceLabel: label,
        accounts: 2,
        skip: () => (maintenance.featureLevel(featureId) ? `« ${label} » est en maintenance` : null),
        steps: [
            {
                label: 'La victime sème dans un espace partagé',
                run: async (ctx) => {
                    const [victim] = ctx.accounts;
                    const { workspace } = await victim.client.send<{ workspace: { id: number } }>('workspace.add', {
                        name: 'Cloisonnement, essai de bout en bout'
                    });
                    ctx.ledger.defer('Supprimer l’espace de la victime', async () => {
                        await victim.client.send('workspace.delete', { workspaceId: workspace.id });
                    });
                    const mark = randomBytes(6).toString('hex');
                    const s: Shared = {
                        workspaceId: workspace.id,
                        ids: {},
                        canary: `canari-${mark}`,
                        itemCanary: `element-${mark}`,
                        baseline: [],
                        roleId: 0
                    };
                    const seedContext: SdkIsolationSeedContext = {
                        account: {
                            userId: victim.userId,
                            username: victim.username,
                            email: victim.email,
                            password: victim.password,
                            workspaceId: victim.workspaceId
                        },
                        send: (command, input, opts) =>
                            victim.client.send(command, input, { workspaceId: workspace.id, ...opts }),
                        fetch: (path, init) => {
                            const host = init?.headers?.host;
                            return ctx.newClient((host && listenerPortForHost(host)) || undefined).http(path, init);
                        },
                        waitFor: (probe, opts) => waitFor(probe, ctx.signal, opts),
                        defer: (what, undo) => ctx.ledger.defer(what, undo),
                        state: ctx.state,
                        repo,
                        origins: ctx.deps.origins,
                        signal: ctx.signal,
                        workspaceId: workspace.id,
                        canary: s.canary,
                        itemCanary: s.itemCanary
                    };
                    s.ids = await isolation.seed(seedContext);
                    const expected = Object.keys(isolation.sampleIds).sort().join(', ');
                    const got = Object.keys(s.ids).sort().join(', ');
                    check(expected === got, `seed rend « ${got} », sampleIds annonce « ${expected} »`);
                    ctx.state.set('isolation', s);
                    return `Espace ${workspace.id}, ${got}`;
                }
            },
            {
                label: 'Elle relit ses données',
                run: async (ctx) => {
                    const [victim] = ctx.accounts;
                    const s = shared(ctx);
                    for (const read of isolation.reads(s.ids)) {
                        const out = await attempt(victim, read, s.workspaceId);
                        check(out.ok, `${show(read)} : la victime elle-même est refusée (${out.ok ? '' : out.code})`);
                        s.baseline.push(out.text);
                    }
                    const seen = s.baseline.join('\n');
                    check(seen.includes(s.canary), 'Aucune lecture ne porte la marque : seed ne l’a posée nulle part');
                    check(
                        itemKeys.length === 0 || seen.includes(s.itemCanary),
                        'Aucune lecture ne porte la marque des éléments : seed ne l’a posée sur aucun'
                    );
                    return `${s.baseline.length} lecture(s)`;
                }
            },
            {
                label: 'L’intrus, depuis son espace',
                run: async (ctx) => {
                    const s = shared(ctx);
                    return allRefused(ctx.accounts[1], s, probesOf(s), isolation.reads(s.ids), lenient);
                }
            },
            {
                label: 'L’intrus, en nommant l’espace de la victime',
                run: async (ctx) => {
                    const s = shared(ctx);
                    return allRefused(ctx.accounts[1], s, probesOf(s), isolation.reads(s.ids), lenient, s.workspaceId);
                }
            },
            {
                label: 'L’intrus, membre de l’espace sans aucun droit',
                run: async (ctx) => {
                    const [victim, intruder] = ctx.accounts;
                    const s = shared(ctx);
                    const ws = { workspaceId: s.workspaceId };
                    await victim.client.send('workspace.invite', { email: intruder.email }, ws);
                    const { invitations } = await intruder.client.send<{
                        invitations: { id: number; workspaceId: number }[];
                    }>('user.invitations', {});
                    const invitation = invitations.find((i) => i.workspaceId === s.workspaceId);
                    check(invitation, 'L’intrus ne reçoit pas l’invitation');
                    await intruder.client.send('workspace.acceptInvite', { invitationId: invitation.id });
                    const { role } = await victim.client.send<{ role: { id: number } }>(
                        'workspace.roleCreate',
                        { ...ROLE, features: [] },
                        ws
                    );
                    s.roleId = role.id;
                    await victim.client.send('workspace.assignRole', { userId: intruder.userId, roleId: role.id }, ws);
                    return allRefused(intruder, s, probesOf(s), isolation.reads(s.ids), lenient, s.workspaceId);
                }
            },
            {
                label: 'Avec le droit d’écrire il voit, puis chaque élément lui est fermé',
                run: async (ctx) => {
                    const [victim, intruder] = ctx.accounts;
                    const s = shared(ctx);
                    const ws = { workspaceId: s.workspaceId };
                    const grant = {
                        feature: featureId,
                        access: 'write',
                        channels: false,
                        itemPermissions: false,
                        extras: {}
                    };
                    await victim.client.send(
                        'workspace.roleUpdate',
                        { ...ROLE, roleId: s.roleId, features: [grant] },
                        ws
                    );
                    // Le contrôle : un membre qui a le droit lit bien ce que la victime a semé.
                    const reads = isolation.reads(s.ids);
                    const visible: string[] = [];
                    for (const read of reads) {
                        const out = await attempt(intruder, read, s.workspaceId);
                        check(
                            out.ok,
                            `${show(read)} : refusée à un membre qui a l’écriture (${out.ok ? '' : out.code})`
                        );
                        visible.push(out.text);
                    }
                    check(visible.join('\n').includes(s.canary), 'Le membre qui a l’écriture ne voit pas les données');
                    if (itemKeys.length === 0) return 'Il lit les données ; le module n’a pas d’élément à fermer';

                    for (const key of itemKeys) {
                        await victim.client.send(
                            'share.grantSet',
                            { feature: featureId, itemId: String(s.ids[key]), roleId: s.roleId, access: 'none' },
                            ws
                        );
                    }
                    const faults: string[] = [];
                    for (const probe of [...probesOf(s), ...reads]) {
                        const closed = targets(probe, itemKeys, s.ids);
                        // Une écriture sur ce qui n'est pas un élément lui est permise : elle ne se tente pas.
                        if (!closed && !reads.includes(probe)) continue;
                        const out = await attempt(intruder, probe, s.workspaceId);
                        if (closed && out.ok) faults.push(`${show(probe)} : a réussi sur un élément fermé`);
                        if (closed && !out.ok && !REFUSALS.has(out.code)) {
                            faults.push(`${show(probe)} : refusée pour une autre raison (${out.code})`);
                        }
                        if (out.text.includes(s.itemCanary)) {
                            faults.push(`${show(probe)} : la réponse porte la marque d’un élément fermé`);
                        }
                    }
                    check(faults.length === 0, faults.join('\n'));
                    return `${itemKeys.length} élément(s) fermé(s), plus rien d’eux dans les réponses`;
                }
            },
            {
                label: 'Les données de la victime n’ont pas bougé',
                run: async (ctx) => {
                    const [victim] = ctx.accounts;
                    const s = shared(ctx);
                    const reads = isolation.reads(s.ids);
                    for (const [index, read] of reads.entries()) {
                        const out = await attempt(victim, read, s.workspaceId);
                        check(
                            out.ok,
                            `${show(read)} : la victime ne relit plus ses données (${out.ok ? '' : out.code})`
                        );
                        check(out.text === s.baseline[index], `${show(read)} : la réponse a changé`);
                    }
                    return `${reads.length} lecture(s) identiques`;
                }
            }
        ]
    };
}
