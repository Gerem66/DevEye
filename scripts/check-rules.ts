/**
 * Vérification du catalogue de règles de Sentinelle.
 *
 * On fabrique des instants, on regarde ce que les règles rendent. Aucune base,
 * aucun agent, aucun réseau : c'est tout l'intérêt d'avoir gardé les règles
 * **pures**, et c'est ce qui rend ce fichier possible dans un dépôt sans cadre
 * de test (`npm test` sort en 1).
 *
 * Ce que ça protège, concrètement : une règle de détection qui cesse de se
 * déclencher ne casse rien, ne lève rien, et ne se voit nulle part — la feature
 * a simplement l'air calme. C'est le pire mode de panne possible pour un
 * détecteur, et le seul filet contre lui est ici.
 *
 * Lancé par `npm run ci:rules`, donc par `npm run ci`.
 */
import type { AuthWindow, DeviceReport, PersistenceEntry, ReportProcess } from 'deveye-types';

import type { BaselineRow } from '@/db/repos/sentinel';
import {
    authRules,
    evaluateReport,
    evaluateSnapshot,
    persistenceRules,
    processKey,
    type EvalContext,
    type FindingDraft
} from '@/Services/security/rules';

let failures = 0;
let checks = 0;

function expect(name: string, drafts: FindingDraft[], expected: string[]): void {
    checks++;
    const got = drafts.map((d) => d.rule).sort();
    const want = [...expected].sort();
    const ok = got.length === want.length && got.every((r, i) => r === want[i]);
    if (ok) {
        console.log(`  ✓ ${name}`);
        return;
    }
    failures++;
    console.log(`  ✗ ${name}\n      attendu : [${want.join(', ')}]\n      obtenu  : [${got.join(', ')}]`);
}

function proc(over: Partial<ReportProcess> & { name: string }): ReportProcess {
    return {
        name: over.name,
        execPath: over.execPath ?? null,
        deleted: over.deleted ?? null,
        instances: over.instances ?? 1,
        cpuPercent: over.cpuPercent ?? 0.1,
        memBytes: over.memBytes ?? 1024 * 1024,
        threads: over.threads ?? null,
        user: over.user ?? 'root',
        uptimeSeconds: over.uptimeSeconds ?? 100,
        diskReadBytes: over.diskReadBytes ?? null,
        diskWriteBytes: over.diskWriteBytes ?? null,
        connIn: over.connIn ?? null,
        connOut: over.connOut ?? null,
        listenPorts: over.listenPorts ?? []
    };
}

function baseRow(key: string, over: Partial<BaselineRow> = {}): BaselineRow {
    return {
        id: 1,
        device_id: 'dev',
        kind: 'process',
        item_key: key,
        first_seen: 1,
        last_seen: 2,
        samples: over.samples ?? 500,
        attrs: {
            users: ['www-data'],
            listenPorts: [],
            cpuP95: 2,
            memP95: null,
            sha256: null,
            surface: null,
            ...((over.attrs as object) ?? {})
        },
        ...over
    } as BaselineRow;
}

function report(over: Partial<DeviceReport> = {}): DeviceReport {
    return {
        collectedAt: Date.now(),
        os: { name: 'Linux', version: '6.1', arch: 'x86_64', cores: 8 },
        security: {
            firewall: null,
            diskEncryption: null,
            sip: null,
            pendingUpdates: null,
            pendingSecurityUpdates: null,
            updatesCheckedAt: null,
            sshRootLogin: null,
            sshPasswordAuth: null,
            mandatoryAccessControl: null,
            rebootRequired: null
        },
        disks: [],
        agent: { privileged: true, user: 'root', serviceScope: 'system', managed: true, probes: [] },
        hardware: null,
        openPorts: null,
        connections: null,
        ...over
    } as DeviceReport;
}

function ctx(over: Partial<EvalContext> = {}): EvalContext {
    return {
        now: Date.now(),
        learning: false,
        snapshot: null,
        report: null,
        baseline: { process: new Map(), listener: new Map(), persistence: new Map() },
        ...over
    };
}

function snap(processes: ReportProcess[], activeConnections: number | null = 10) {
    return { ts: 1_700_000_000_000, processes, activeConnections };
}

/** Une ligne de base où le programme donné est connu et banal. */
function known(key: string, over: Partial<BaselineRow> = {}) {
    return {
        process: new Map([[key, baseRow(key, over)]]),
        listener: new Map<string, BaselineRow>(),
        persistence: new Map<string, BaselineRow>()
    };
}

console.log('\nRègles d’exécution');
expect(
    'binaire dans /tmp',
    evaluateSnapshot(ctx({ snapshot: snap([proc({ name: 'kdevtmpfsi', execPath: '/tmp/kdevtmpfsi' })]) })),
    ['exec.suspicious_path', 'process.new']
);
expect(
    'binaire disparu du disque',
    evaluateSnapshot(ctx({ snapshot: snap([proc({ name: 'sshd', execPath: '/usr/sbin/sshd', deleted: true })]) })),
    ['exec.deleted_binary', 'process.new']
);
expect(
    'binaire présent : rien à signaler de ce côté',
    evaluateSnapshot(
        ctx({
            snapshot: snap([proc({ name: 'sshd', execPath: '/usr/sbin/sshd', deleted: false, user: 'www-data' })]),
            baseline: known('sshd|/usr/sbin/sshd')
        })
    ),
    []
);
expect(
    'nom de thread noyau avec un vrai chemin',
    evaluateSnapshot(ctx({ snapshot: snap([proc({ name: 'kworker/0:1', execPath: '/usr/bin/miner' })]) })),
    ['exec.masquerade', 'process.new']
);
expect(
    'sans chemin, exec.* se tait (agent trop ancien)',
    evaluateSnapshot(
        ctx({
            snapshot: snap([proc({ name: 'kworker/0:1', execPath: null, user: 'root' })]),
            baseline: known('kworker/0:1', { attrs: { users: ['root'] } as never })
        })
    ),
    []
);

console.log('\nRègles réseau');
expect(
    'shell avec connexion sortante',
    evaluateSnapshot(
        ctx({
            snapshot: snap([proc({ name: 'bash', execPath: '/usr/bin/bash', connOut: 1 })]),
            baseline: known('bash|/usr/bin/bash', { attrs: { users: ['root'] } as never })
        })
    ),
    ['net.shell_outbound']
);
expect(
    'connOut inconnu (null) ne déclenche pas',
    evaluateSnapshot(
        ctx({
            snapshot: snap([proc({ name: 'bash', execPath: '/usr/bin/bash', connOut: null })]),
            baseline: known('bash|/usr/bin/bash', { attrs: { users: ['root'] } as never })
        })
    ),
    []
);
// Les connexions établies viennent du rapport, pas de l'instant : la règle est
// donc rangée avec `evaluateReport`, malgré son préfixe `net.`.
expect(
    'connexion vers un pool de minage',
    evaluateReport(
        ctx({
            report: report({
                connections: [
                    { localAddress: '10.0.0.2', localPort: 51234, remoteAddress: '1.2.3.4', remotePort: 14444 }
                ]
            })
        })
    ),
    ['net.mining_pool']
);

console.log('\nRègles de ports');
expect(
    'nouveau port exposé au monde',
    evaluateReport(
        ctx({
            report: report({
                openPorts: [{ proto: 'tcp', port: 8099, address: '0.0.0.0', zone: null, pid: 42, process: 'python3' }]
            })
        })
    ),
    ['port.exposed']
);
expect(
    'port sur la boucle locale : rien',
    evaluateReport(
        ctx({
            report: report({
                openPorts: [{ proto: 'tcp', port: 8099, address: '127.0.0.1', zone: null, pid: 42, process: 'python3' }]
            })
        })
    ),
    []
);
expect(
    'écoute sans propriétaire malgré les privilèges',
    evaluateReport(
        ctx({
            report: report({
                openPorts: [{ proto: 'tcp', port: 31337, address: '127.0.0.1', zone: null, pid: null, process: null }]
            })
        })
    ),
    ['port.unattributed']
);
expect(
    'même écoute, agent non privilégié : rien',
    evaluateReport(
        ctx({
            report: report({
                agent: { privileged: false, user: 'deploy', serviceScope: 'user', managed: true, probes: [] },
                openPorts: [{ proto: 'tcp', port: 31337, address: '127.0.0.1', zone: null, pid: null, process: null }]
            })
        })
    ),
    []
);

console.log('\nRègles de dérive');
expect(
    'changement de compte vers root',
    evaluateSnapshot(
        ctx({
            snapshot: snap([proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'root' })]),
            baseline: known('nginx|/usr/sbin/nginx')
        })
    ),
    ['process.user_changed']
);
expect(
    'programme connu qui se met à écouter',
    evaluateSnapshot(
        ctx({
            snapshot: snap([
                proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'www-data', listenPorts: [4444] })
            ]),
            baseline: known('nginx|/usr/sbin/nginx')
        })
    ),
    ['process.new_listener']
);
expect(
    'consommation hors enveloppe',
    evaluateSnapshot(
        ctx({
            snapshot: snap([proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'www-data', cpuPercent: 95 })]),
            baseline: known('nginx|/usr/sbin/nginx')
        })
    ),
    ['process.resource_anomaly']
);
expect(
    'enveloppe non constituée : rien',
    evaluateSnapshot(
        ctx({
            snapshot: snap([proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'www-data', cpuPercent: 95 })]),
            baseline: known('nginx|/usr/sbin/nginx', { samples: 5 })
        })
    ),
    []
);
expect(
    'PENDANT L’APPRENTISSAGE : dérive muette, exec.* toujours actif',
    evaluateSnapshot(
        ctx({
            learning: true,
            snapshot: snap([proc({ name: 'kdevtmpfsi', execPath: '/tmp/kdevtmpfsi' })]),
            report: report({
                openPorts: [{ proto: 'tcp', port: 8099, address: '0.0.0.0', zone: null, pid: 1, process: 'x' }]
            })
        })
    ),
    ['exec.suspicious_path']
);

console.log('\nRègles de posture');
expect(
    'pare-feu éteint + SSH root + mots de passe',
    evaluateReport(
        ctx({
            report: report({
                security: {
                    firewall: false,
                    diskEncryption: null,
                    sip: null,
                    pendingUpdates: null,
                    pendingSecurityUpdates: null,
                    updatesCheckedAt: null,
                    sshRootLogin: true,
                    sshPasswordAuth: true,
                    mandatoryAccessControl: null,
                    rebootRequired: null
                }
            })
        })
    ),
    ['posture.firewall_off', 'posture.ssh_root_login', 'posture.ssh_password_auth']
);
expect('sondes toutes à null : AUCUN constat (pas de fausse assurance)', evaluateReport(ctx({ report: report() })), []);

console.log('\nSéparation des cadences');
// Le rapport arrive une fois par heure, l'instant toutes les soixante secondes.
// Tant que la posture vivait dans `evaluateSnapshot`, chaque lot de métriques la
// re-constatait sur un rapport inchangé : « constaté 1206 fois » comptait des
// tours de moteur, et « dernière fois il y a 5 min » datait un fait relevé
// jusqu'à une heure plus tôt. Ces deux assertions tiennent la frontière.
const posture = report({
    security: {
        firewall: false,
        diskEncryption: null,
        sip: null,
        pendingUpdates: null,
        pendingSecurityUpdates: null,
        updatesCheckedAt: null,
        sshRootLogin: true,
        sshPasswordAuth: true,
        mandatoryAccessControl: null,
        rebootRequired: null
    },
    openPorts: [{ proto: 'tcp', port: 8099, address: '0.0.0.0', zone: null, pid: 42, process: 'python3' }],
    connections: [{ localAddress: '10.0.0.2', localPort: 51234, remoteAddress: '1.2.3.4', remotePort: 14444 }]
});
expect(
    'un instant banal ne rejoue RIEN de ce que porte le rapport',
    evaluateSnapshot(
        ctx({
            snapshot: snap([proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'www-data' })]),
            baseline: known('nginx|/usr/sbin/nginx'),
            report: posture
        })
    ),
    []
);
expect(
    'un rapport ne rejoue AUCUNE règle d’instant (sinon il les résoudrait toutes)',
    evaluateReport(ctx({ snapshot: null, report: posture })),
    ['net.mining_pool', 'port.exposed', 'posture.firewall_off', 'posture.ssh_root_login', 'posture.ssh_password_auth']
);

console.log('\nRègles de persistance');
const entry = (over: Partial<PersistenceEntry> & { path: string; sha256: string }): PersistenceEntry => ({
    surface: over.surface ?? 'cron',
    path: over.path,
    sha256: over.sha256,
    sizeBytes: over.sizeBytes ?? 120,
    mtime: over.mtime ?? null,
    mode: over.mode ?? '0644',
    owner: over.owner ?? 'root'
});
const withPersistence = (path: string, sha256: string) => ({
    process: new Map<string, BaselineRow>(),
    listener: new Map<string, BaselineRow>(),
    persistence: new Map([[path, baseRow(path, { kind: 'persistence', attrs: { sha256 } as never })]])
});

expect(
    'nouvelle entrée cron',
    persistenceRules(ctx(), [entry({ path: '/etc/cron.d/zz-test', sha256: 'a'.repeat(64) })], false),
    ['persistence.added']
);
expect(
    'empreinte changée',
    persistenceRules(
        ctx({ baseline: withPersistence('/etc/cron.d/backup', 'b'.repeat(64)) }),
        [entry({ path: '/etc/cron.d/backup', sha256: 'c'.repeat(64) })],
        false
    ),
    ['persistence.modified']
);
expect(
    'manifeste tronqué : aucune suppression signalée',
    persistenceRules(ctx({ baseline: withPersistence('/etc/cron.d/gone', 'd'.repeat(64)) }), [], true),
    []
);
expect(
    'manifeste complet : suppression signalée',
    persistenceRules(ctx({ baseline: withPersistence('/etc/cron.d/gone', 'd'.repeat(64)) }), [], false),
    ['persistence.removed']
);

console.log('\nRègles d’authentification');
const authWin = (over: Partial<AuthWindow> = {}): AuthWindow => ({
    from: 1_700_000_000_000,
    to: 1_700_003_600_000,
    failed: 0,
    accepted: 0,
    invalidUser: 0,
    sudo: 0,
    newAccounts: [],
    rootLogins: 0,
    topSources: [],
    logins: [],
    unavailable: false,
    ...over
});
expect(
    'tentatives répétées',
    authRules(ctx(), authWin({ topSources: [{ address: '1.2.3.4', failed: 42, accepted: 0, users: ['root'] }] })),
    ['auth.bruteforce']
);
expect(
    'réussite après échecs',
    authRules(ctx(), authWin({ topSources: [{ address: '1.2.3.4', failed: 6, accepted: 1, users: ['deploy'] }] })),
    ['auth.success_after_failures']
);
expect('création de compte', authRules(ctx(), authWin({ newAccounts: ['backdoor'] })), ['auth.new_account']);
expect(
    'journal illisible : AUCUN constat (pas de fausse tranquillité)',
    authRules(
        ctx(),
        authWin({ unavailable: true, topSources: [{ address: '1.2.3.4', failed: 99, accepted: 1, users: [] }] })
    ),
    []
);

console.log('\nClé de programme');
checks++;
if (processKey(proc({ name: 'nginx', execPath: '/usr/sbin/nginx' })) === 'nginx|/usr/sbin/nginx') {
    console.log('  ✓ clé avec chemin');
} else {
    failures++;
    console.log('  ✗ clé avec chemin');
}
checks++;
if (processKey(proc({ name: 'nginx', execPath: null })) === 'nginx') {
    console.log('  ✓ clé sans chemin retombe sur le nom');
} else {
    failures++;
    console.log('  ✗ clé sans chemin retombe sur le nom');
}

console.log(`\n${checks - failures}/${checks} vérifications passées`);
process.exit(failures > 0 ? 1 : 0);
