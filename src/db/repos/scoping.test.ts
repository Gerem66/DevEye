import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defaultUserColor, SYSTEM_NOTIFICATION_TARGET } from '@deveye/types';

import type { Database } from '../index';
import { fakeDatabase } from '../pool.fake';

/**
 * Le cloisonnement des dépôts. Un `AND workspace_id = ?` oublié n'échoue nulle
 * part : la requête rend simplement les lignes des autres espaces. Ici, chaque
 * méthode de chaque dépôt déclare la garde que le WHERE de ses requêtes doit
 * porter (l'espace, le compte, l'appareil, ou le secret qui tient lieu
 * d'identité), ou dit noir sur blanc pourquoi elle lit toute l'instance. Une
 * méthode ajoutée sans déclaration ne compile pas, et ne passe pas non plus.
 */

type RepoKey = Exclude<keyof Database, 'queryable' | 'transaction'>;

/** Ce que le WHERE d'une requête doit contenir : un des motifs suffit. */
type Guard = readonly RegExp[];

type MethodCase<F> = F extends (...args: infer A) => unknown
    ? {
          args: A;
          /** Remplace la garde du dépôt pour cette méthode. */
          guard?: Guard;
          /** Pourquoi cette méthode lit toute l'instance. */
          global?: string;
      }
    : never;

interface CaseShape {
    args: readonly unknown[];
    guard?: Guard;
    global?: string;
}

interface RepoScope<K extends RepoKey> {
    guard?: Guard;
    /** Pourquoi ce dépôt lit toute l'instance : ses méthodes en héritent. */
    global?: string;
    methods: { [M in keyof Database[K]]: MethodCase<Database[K][M]> };
}

const WORKSPACE: Guard = [/\bworkspace_id = \?/, /\bworkspace_id IN \(/, /\bhome_workspace_id = \?/];
const ACCOUNT: Guard = [/\buser_id = \?/, /\buser_id IN \(/];
const OWNER: Guard = [/\bowner_user_id = \?/];
const DEVICE: Guard = [/\bdevice_id = \?/];
/**
 * La ligne elle-même, par une clé qu'une lecture déjà cloisonnée a rendue, ou
 * par l'identifiant d'un appareil, un UUID que seul l'agent connaît.
 */
const ROW: Guard = [/\bid = \?/, /\bid IN \(/];
/** Un secret que seul son porteur détient : il vaut identité. */
const SECRET: Guard = [/\b(code|jti|session_id|token_hash|watch_hash) = \?/];

const ROLE_INPUT = { name: 'r', color: 'red', capabilities: [], features: [] };
const CHANNEL_INPUT = { kind: 'email' as const, labelEnc: null, targetEnc: null, mailAccountId: null, enabled: true };
const VERDICT = {
    dns_state: 'pending' as const,
    dns_error: '',
    probe_state: 'pending' as const,
    probe_error: '',
    verified_at: null,
    checked_at: null,
    failures: 0,
    next_probe_at: null
};

const SCOPES: { [K in RepoKey]: RepoScope<K> } = {
    users: {
        guard: ROW,
        methods: {
            findById: { args: [1] },
            findByUsername: { args: ['u'], global: 'la connexion cherche le compte par son pseudo' },
            findByEmail: { args: ['a@b.c'], global: 'la connexion cherche le compte par son adresse' },
            findByIds: { args: [[1, 2]] },
            all: { args: [], global: "relevé d'administration" },
            search: { args: ['u', 10], global: "recherche d'administration" },
            create: { args: [{ email: 'a@b.c', username: 'u', passwordHash: 'h' }] },
            updateLastLogin: { args: [1, 0] },
            setPersonalWorkspace: { args: [1, 2] },
            setDefaultWorkspace: { args: [1, null] },
            updatePasswordHash: { args: [1, 'h'] },
            updateAvatar: { args: [1, 'a'] },
            updateUsername: { args: [1, 'u'] },
            updateColor: { args: [1, defaultUserColor(1)] },
            updateSettings: { args: [1, []] },
            setRole: { args: [1, 'user'] },
            setStatus: { args: [1, 'active'] },
            delete: { args: [1] },
            listForAdmin: { args: [], global: 'la page Utilisateurs' },
            listAdminIds: { args: [], global: 'les administrateurs à prévenir' },
            setReAuthInterval: { args: [1, null] },
            count: { args: [], global: 'le premier compte devient administrateur' },
            countForUpdate: { args: [], global: 'le premier compte devient administrateur' }
        }
    },
    workspaces: {
        guard: ROW,
        methods: {
            findById: { args: [1] },
            findAccessibleByUser: { args: [1], guard: ACCOUNT },
            listAll: { args: [], global: 'administration de la flotte' },
            listOwnedIds: { args: [1], guard: OWNER },
            listOwnedShared: { args: [1], guard: OWNER },
            listOwnerIds: { args: [], global: 'tous les propriétaires, pour les quotas' },
            createPersonal: { args: [1, 'p'] },
            create: { args: [{ ownerUserId: 1, name: 'w' }] },
            rename: { args: [1, 'w'] },
            delete: { args: [1], guard: [...ROW, ...WORKSPACE] },
            updateFeatures: { args: [1, []] },
            setTheme: { args: [1, 't'] },
            setHomeLayout: { args: [1, 'l'] }
        }
    },
    workspaceMembers: {
        guard: WORKSPACE,
        methods: {
            listByWorkspaceIds: { args: [[1]] },
            add: { args: [{ userId: 1, workspaceId: 2 }], guard: ROW },
            remove: { args: [1, 2] },
            isMember: { args: [1, 2] }
        }
    },
    workspaceSecretKeys: {
        guard: WORKSPACE,
        methods: {
            get: { args: [1] },
            create: { args: [1, 'dek'] }
        }
    },
    workspaceRoles: {
        guard: WORKSPACE,
        methods: {
            listByWorkspace: { args: [1] },
            findById: { args: [1, 2] },
            findForMember: { args: [1, 2] },
            findDefault: { args: [1] },
            create: { args: [1, ROLE_INPUT] },
            update: { args: [1, 2, ROLE_INPUT] },
            delete: { args: [1, 2] },
            memberCount: { args: [1], guard: [/\brole_id = \?/] },
            setDefault: { args: [1, 2] },
            assign: { args: [1, 2, null] },
            reorder: { args: [1, [2, 3]] },
            memberRoles: { args: [1] }
        }
    },
    refreshTokens: {
        guard: [...SECRET, ...ACCOUNT],
        methods: {
            newSessionId: { args: [] },
            store: { args: [{ jti: 'j', userId: 1, sessionId: 's', token: 't', expiresAt: 0 }] },
            isValid: { args: ['j', 't'] },
            wasRecentlyRotated: { args: ['j', 't', 5] },
            revoke: { args: ['j'] },
            revokeSession: { args: ['s'] },
            revokeUser: { args: [1] },
            revokeUserExcept: { args: [1, 's'] },
            hasLiveSession: { args: ['s'] }
        }
    },
    remoteInstances: {
        guard: ACCOUNT,
        methods: {
            listByUser: { args: [1] },
            findOwned: { args: [1, 2] },
            findByOrigin: { args: [1, 'https://x'] },
            countByUser: { args: [1] },
            create: { args: [{ userId: 1, label: 'l', origin: 'https://x' }] },
            rename: { args: [1, 2, 'l'] },
            remove: { args: [1, 2] },
            reorder: { args: [1, [2]] }
        }
    },
    logs: {
        global: "le journal d'administration, filtré par compte quand l'écran le demande",
        methods: {
            record: { args: [{ uid: 1, ip: '', source: 's', category: 'c', action: 'a', level: 1, description: 'd' }] },
            query: { args: [{}, { limit: 10, offset: 0 }] },
            facets: { args: [] },
            purgeBefore: { args: [0, 10] }
        }
    },
    feedback: {
        global: "les signalements, relus par l'administration",
        methods: {
            record: {
                args: [
                    { uid: 1, workspaceId: null, kind: 'bug', message: 'm', snapshot: null, ip: '', appVersion: '1' }
                ]
            },
            query: { args: [{}, { limit: 10, offset: 0 }] },
            findById: { args: [1] },
            setStatus: { args: [1, 'new', 2] },
            remove: { args: [1] },
            countSince: { args: [1, 0] }
        }
    },
    maintenance: {
        global: "les réglages de l'instance entière",
        methods: {
            site: { args: [] },
            features: { args: [] },
            setSite: { args: [true, null, 1] },
            setPriority: { args: [true, 1] },
            seedFromEnv: { args: [] },
            dismissEnvNotice: { args: [] },
            setFeature: { args: ['f', 'full', 1] }
        }
    },
    devices: {
        guard: [...WORKSPACE, ...ROW],
        methods: {
            findById: { args: ['d'] },
            findByWorkspaceFingerprint: { args: [1, 'fp'] },
            findVisible: { args: ['d', 1] },
            listByWorkspace: { args: [1] },
            create: {
                args: [
                    {
                        ownerId: 1,
                        workspaceId: 1,
                        name: 'n',
                        fingerprint: 'fp',
                        platform: 'linux',
                        status: 'active',
                        tokenHash: 'h'
                    }
                ]
            },
            setTokenHashes: { args: ['d', 'c', null] },
            clearPreviousTokenHash: { args: ['d'] },
            touchSeen: { args: ['d', 0] },
            setAgentVersion: { args: ['d', '1'] },
            setAgentTarget: { args: ['d', 't'] },
            setReport: { args: ['d', '{}'] },
            markEnrolled: { args: ['d', 'active'] },
            countActiveInWorkspaces: { args: [[1]] },
            archive: { args: ['d'] },
            failDeletion: { args: ['d', 'm'] }
        }
    },
    linkCodes: {
        guard: SECRET,
        methods: {
            peek: { args: ['c'] },
            consume: { args: ['c'] }
        }
    },
    metrics: {
        guard: DEVICE,
        methods: {
            insertBatch: { args: ['d', []] },
            query: { args: [{ deviceId: 'd', from: 0, to: 1, resolution: 'raw' }] },
            latest: { args: ['d'] },
            setInstantsPinned: { args: ['d', 0, 1, true] }
        }
    },
    pendingSignups: {
        guard: SECRET,
        methods: {
            // Une adresse n'a qu'une demande : la nouvelle chasse l'ancienne.
            replace: {
                args: [
                    {
                        email: 'a@b.c',
                        username: 'u',
                        tokenHash: 't',
                        watchHash: 'w',
                        plan: null,
                        termsAcceptedAt: null,
                        expiresAt: 0
                    }
                ],
                guard: [/\bemail = \?/]
            },
            findLiveByTokenHash: { args: ['t', 0] },
            findByWatchHash: { args: ['w'] },
            markOpened: { args: [1, 0], guard: ROW },
            markCompleted: { args: [1, 0], guard: ROW },
            usernameHeld: {
                args: ['u', 'a@b.c', 0],
                global: 'le pseudo se vérifie contre toutes les demandes vivantes'
            },
            purgeExpired: { args: [0], global: 'le ménage des demandes échues' }
        }
    },
    presence: {
        guard: DEVICE,
        methods: {
            record: { args: ['d', 0, true] },
            onlineAt: { args: ['d', 0] }
        }
    },
    processSamples: {
        guard: DEVICE,
        methods: {
            insertSample: { args: ['d', 0, 'top', []] },
            nearest: { args: ['d', 0] }
        }
    },
    quotaPauses: {
        guard: OWNER,
        methods: {
            all: { args: [], global: "toutes les pauses, pour l'ordonnanceur" },
            ofOwnerKey: { args: [1, 'k'] },
            upsert: { args: [[]] },
            remove: { args: [1, 'k', ['i']] },
            purgeKeysOtherThan: { args: [['k']], global: 'le ménage des clés que plus aucun module ne tient' },
            owners: { args: [], global: 'tous les propriétaires à revoir' },
            setRecheck: { args: [1, 0] },
            takeDueRechecks: { args: [0], global: "l'échéancier entier" }
        }
    },
    twoFactor: {
        guard: ACCOUNT,
        methods: {
            get: { args: [1] },
            upsertSecret: { args: [1, 's'] },
            enable: { args: [1] },
            disable: { args: [1] },
            replaceBackupCodes: { args: [1, ['h']] },
            countUnusedBackupCodes: { args: [1] },
            findUnusedBackupCode: { args: [1, 'h'] },
            markBackupCodeUsed: { args: [1], guard: ROW },
            claimTotpCounter: { args: [1, 2] }
        }
    },
    userSecretKeys: {
        guard: ACCOUNT,
        methods: {
            get: { args: [1] },
            create: { args: [1, 'dek'] },
            setWrap: {
                args: [
                    1,
                    {
                        dekWrapped: 'dek',
                        wrapMode: 'server',
                        kdfSalt: null,
                        version: 1,
                        recoveryWrapped: null,
                        recoverySalt: null,
                        recoveryVersion: 1
                    }
                ]
            },
            setOpenDek: { args: [1, 'o'] }
        }
    },
    featureDomains: {
        guard: WORKSPACE,
        methods: {
            list: { args: [1, 'f'] },
            find: { args: [1, 2, 'f'] },
            findByHost: { args: ['f', 'h'], global: "l'hôte est unique sur toute l'instance" },
            insert: { args: [{ workspaceId: 1, feature: 'f', host: 'h', token: 't', now: 0 }] },
            saveState: { args: [1, VERDICT], guard: ROW },
            delete: { args: [1, 2, 'f'] },
            rowsOf: { args: [[1], ['f']] },
            due: { args: [0, 10, ['f']], global: 'la vérification périodique parcourt tous les espaces' },
            hostsOf: { args: [[1], ['f']] },
            routable: { args: [['f'], []], global: 'le proxy sert les domaines de tous les espaces' }
        }
    },
    featureKv: {
        guard: WORKSPACE,
        methods: {
            get: { args: [1, 'f', 'k'] },
            put: { args: [1, 'f', 'k', 'none', 'v'] },
            remove: { args: [1, 'f', 'k'] },
            keys: { args: [1, 'f', 'p'] }
        }
    },
    itemSharing: {
        guard: WORKSPACE,
        methods: {
            sharesOf: { args: ['f', 'i', 1] },
            sharedInto: { args: [1, 'f'] },
            findShare: { args: [1, 'f', 'i'] },
            share: {
                args: [{ workspace_id: 1, feature: 'f', item_id: 'i', home_workspace_id: 2, shared_by_user_id: 3 }]
            },
            unshare: { args: [1, 'f', 'i'] },
            setOrder: { args: [1, 'f', 'i', 0] },
            // Les restrictions d'un élément supprimé partent de tous les espaces :
            // l'identifiant d'un élément est unique dans sa fonctionnalité.
            forgetItem: { args: ['f', 'i', 1], guard: [...WORKSPACE, /\bitem_id = \?/] },
            linkedWorkspaces: { args: [1, 'f'] },
            grantsOf: { args: [1, 'f', 'i'] },
            grantsForRole: { args: [1, 'f', 2] },
            allGrantsForRole: { args: [1, 2] },
            setGrant: { args: [1, 'f', 'i', 2, {}] }
        }
    },
    notificationChannels: {
        guard: WORKSPACE,
        methods: {
            list: { args: [1, SYSTEM_NOTIFICATION_TARGET] },
            findById: { args: [1, 2] },
            create: { args: [1, SYSTEM_NOTIFICATION_TARGET, CHANNEL_INPUT] },
            update: { args: [1, 2, CHANNEL_INPUT] },
            remove: { args: [1, 2] },
            reorder: { args: [1, [2]] },
            usageCounts: { args: [1] },
            usageDetail: { args: [1, 2] },
            findRoute: { args: [1, SYSTEM_NOTIFICATION_TARGET, 0] },
            routeChannelIds: { args: [1], guard: [/\broute_id = \?/] },
            setRoute: { args: [1, SYSTEM_NOTIFICATION_TARGET, 0, [2]], guard: [...WORKSPACE, /\broute_id = \?/] },
            clearRoute: { args: [1, SYSTEM_NOTIFICATION_TARGET, 0] },
            systemRouteWorkspaces: { args: [], global: 'les espaces à prévenir des alertes système' }
        }
    },
    instanceSettings: {
        global: "les réglages de l'instance, par origine publique",
        methods: {
            get: { args: ['n', 'o'] },
            put: { args: ['n', 'o', 'v', 1] },
            remove: { args: ['n', 'o'] },
            listByName: { args: ['n'] }
        }
    },
    debug: {
        global: 'la page Tests et débogage, réservée aux administrateurs',
        methods: {
            insertRun: { args: [{ origin: 'o', kind: 'e2e', started: 0, userId: 1, report: '{}' }] },
            finishRun: { args: [1, { status: 'passed', finished: 0, report: '{}' }] },
            getRun: { args: [1, 'o'] },
            listRuns: { args: ['o', 'e2e', 10] },
            prune: { args: ['o', 'e2e', 5] },
            abortStale: { args: ['o', 0] },
            testAccounts: { args: [] },
            purgeLogsOf: { args: [[1]] },
            purgeOrphanLogsNaming: { args: ['p', 0] },
            purgeSignupsLike: { args: ['%x%'] }
        }
    }
};

/**
 * Une ligne qui satisfait n'importe quelle relecture : un dépôt qui relit ce
 * qu'il vient d'écrire ne doit pas s'arrêter avant d'avoir tout émis.
 */
const ANY_ROW = {
    id: 1,
    n: 0,
    count: 0,
    total: 0,
    pending: 0,
    next: 0,
    ts: 0,
    uid: 1,
    user_id: 1,
    owner_user_id: 1,
    workspace_id: 1,
    channel_id: 1,
    host: 'h',
    k: 'k'
};

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('le cloisonnement des dépôts', () => {
    for (const repo of Object.keys(SCOPES) as RepoKey[]) {
        const scope: RepoScope<RepoKey> = SCOPES[repo];
        const cases = scope.methods as Record<string, CaseShape>;

        describe(repo, () => {
            it('déclare chacune de ses méthodes', () => {
                const { db } = fakeDatabase();
                assert.deepEqual(Object.keys(db[repo]).sort(), Object.keys(cases).sort());
            });

            for (const [method, c] of Object.entries(cases)) {
                it(method, async () => {
                    const { db, queries } = fakeDatabase((sql) => (/^\s*SELECT\b/i.test(sql) ? [ANY_ROW] : undefined));
                    const target = db[repo] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
                    await target[method]!(...c.args);

                    if ((c.global ?? scope.global) !== undefined) return;
                    const guard = c.guard ?? scope.guard;
                    assert.ok(guard, `${repo}.${method} : ni garde, ni raison de lire toute l'instance`);

                    for (const query of queries) {
                        const sql = normalize(query.sql);
                        const at = sql.search(/\bWHERE\b/i);
                        if (at === -1) {
                            assert.match(sql, /^INSERT\b/i, `${repo}.${method} : une requête sans WHERE :\n${sql}`);
                            continue;
                        }
                        const where = sql.slice(at);
                        assert.ok(
                            guard.some((g) => g.test(where)),
                            `${repo}.${method} : le WHERE ne porte pas sa garde :\n${sql}`
                        );
                    }
                });
            }
        });
    }
});
