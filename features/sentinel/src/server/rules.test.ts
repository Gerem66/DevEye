import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AuthWindow, DeviceReport, PersistenceEntry, ReportProcess } from '@deveye/types';

import type { BaselineRow, FindingDraft } from './repo';
import { authRules, evaluateReport, evaluateSnapshot, persistenceRules, processKey, type EvalContext } from './rules';

/**
 * Des instants fabriqués, ce que les règles en rendent : ni base, ni agent, ni
 * réseau, les règles sont pures. Une règle qui cesse de se déclencher ne casse
 * rien et ne se voit nulle part, la feature a simplement l'air calme : le seul
 * filet contre ce mode de panne est ici.
 */

function expectRules(drafts: FindingDraft[], expected: string[]): void {
    assert.deepEqual(drafts.map((d) => d.rule).sort(), [...expected].sort());
}

function proc(over: Partial<ReportProcess> & { name: string }): ReportProcess {
    return {
        name: over.name,
        execPath: over.execPath ?? null,
        deleted: over.deleted ?? null,
        kernel: over.kernel ?? null,
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

describe('Règles d’exécution', () => {
    it('binaire dans /tmp', () => {
        expectRules(
            evaluateSnapshot(ctx({ snapshot: snap([proc({ name: 'kdevtmpfsi', execPath: '/tmp/kdevtmpfsi' })]) })),
            ['exec.suspicious_path', 'process.new']
        );
    });
    it('binaire disparu du disque', () => {
        expectRules(
            evaluateSnapshot(
                ctx({ snapshot: snap([proc({ name: 'sshd', execPath: '/usr/sbin/sshd', deleted: true })]) })
            ),
            ['exec.deleted_binary', 'process.new']
        );
    });
    it('binaire présent : rien à signaler de ce côté', () => {
        expectRules(
            evaluateSnapshot(
                ctx({
                    snapshot: snap([
                        proc({ name: 'sshd', execPath: '/usr/sbin/sshd', deleted: false, user: 'www-data' })
                    ]),
                    baseline: known('sshd|/usr/sbin/sshd')
                })
            ),
            []
        );
    });
    it('nom de thread noyau avec un vrai chemin', () => {
        expectRules(
            evaluateSnapshot(ctx({ snapshot: snap([proc({ name: 'kworker/0:1', execPath: '/usr/bin/miner' })]) })),
            ['exec.masquerade', 'process.new']
        );
    });
    it('sans chemin, exec.* se tait (agent trop ancien)', () => {
        expectRules(
            evaluateSnapshot(
                ctx({
                    snapshot: snap([proc({ name: 'kworker/0:1', execPath: null, user: 'root' })]),
                    baseline: known('kworker/0:1', { attrs: { users: ['root'] } as never })
                })
            ),
            []
        );
    });
});

describe('Règles réseau', () => {
    it('shell avec connexion sortante', () => {
        expectRules(
            evaluateSnapshot(
                ctx({
                    snapshot: snap([proc({ name: 'bash', execPath: '/usr/bin/bash', connOut: 1 })]),
                    baseline: known('bash|/usr/bin/bash', { attrs: { users: ['root'] } as never })
                })
            ),
            ['net.shell_outbound']
        );
    });
    it('connOut inconnu (null) ne déclenche pas', () => {
        expectRules(
            evaluateSnapshot(
                ctx({
                    snapshot: snap([proc({ name: 'bash', execPath: '/usr/bin/bash', connOut: null })]),
                    baseline: known('bash|/usr/bin/bash', { attrs: { users: ['root'] } as never })
                })
            ),
            []
        );
    });
    // Les connexions établies viennent du rapport, pas de l'instant : la règle est
    // donc rangée avec `evaluateReport`, malgré son préfixe `net.`.
    it('connexion vers un pool de minage', () => {
        expectRules(
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
    });
});

describe('Règles de ports', () => {
    it('nouveau port exposé au monde', () => {
        expectRules(
            evaluateReport(
                ctx({
                    report: report({
                        openPorts: [
                            { proto: 'tcp', port: 8099, address: '0.0.0.0', zone: null, pid: 42, process: 'python3' }
                        ]
                    })
                })
            ),
            ['port.exposed']
        );
    });
    it('port sur la boucle locale : rien', () => {
        expectRules(
            evaluateReport(
                ctx({
                    report: report({
                        openPorts: [
                            { proto: 'tcp', port: 8099, address: '127.0.0.1', zone: null, pid: 42, process: 'python3' }
                        ]
                    })
                })
            ),
            []
        );
    });
    it('écoute sans propriétaire malgré les privilèges', () => {
        expectRules(
            evaluateReport(
                ctx({
                    report: report({
                        openPorts: [
                            { proto: 'tcp', port: 31337, address: '127.0.0.1', zone: null, pid: null, process: null }
                        ]
                    })
                })
            ),
            ['port.unattributed']
        );
    });
    it('même écoute, agent non privilégié : rien', () => {
        expectRules(
            evaluateReport(
                ctx({
                    report: report({
                        agent: { privileged: false, user: 'deploy', serviceScope: 'user', managed: true, probes: [] },
                        openPorts: [
                            { proto: 'tcp', port: 31337, address: '127.0.0.1', zone: null, pid: null, process: null }
                        ]
                    })
                })
            ),
            []
        );
    });
});

describe('Règles de dérive', () => {
    it('changement de compte vers root', () => {
        expectRules(
            evaluateSnapshot(
                ctx({
                    snapshot: snap([proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'root' })]),
                    baseline: known('nginx|/usr/sbin/nginx')
                })
            ),
            ['process.user_changed']
        );
    });
    it('programme connu qui se met à écouter', () => {
        expectRules(
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
    });
    it('consommation hors enveloppe', () => {
        expectRules(
            evaluateSnapshot(
                ctx({
                    snapshot: snap([
                        proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'www-data', cpuPercent: 95 })
                    ]),
                    baseline: known('nginx|/usr/sbin/nginx')
                })
            ),
            ['process.resource_anomaly']
        );
    });
    it('enveloppe non constituée : rien', () => {
        expectRules(
            evaluateSnapshot(
                ctx({
                    snapshot: snap([
                        proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'www-data', cpuPercent: 95 })
                    ]),
                    baseline: known('nginx|/usr/sbin/nginx', { samples: 5 })
                })
            ),
            []
        );
    });
    it('PENDANT L’APPRENTISSAGE : dérive muette, exec.* toujours actif', () => {
        expectRules(
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
    });
});

describe('Fils du noyau', () => {
    it('un kworker ne produit aucune dérive, connu ou pas', () => {
        const kworker = proc({ name: 'kworker/6:0H-kblockd', kernel: true, user: 'root' });
        expectRules(evaluateSnapshot(ctx({ snapshot: snap([kworker]) })), []);
        expectRules(evaluateSnapshot(ctx({ snapshot: snap([kworker]), baseline: known('kworker/6:0H-kblockd') })), []);
    });
    it('sans le drapeau, le nom indexé suffit : c’est lui que le noyau recycle', () => {
        for (const name of ['kworker/u134:1-ttm', 'jbd2/nvme1n1p1-8', 'irq/34-nvme0q0', '[kthreadd]']) {
            expectRules(evaluateSnapshot(ctx({ snapshot: snap([proc({ name })]) })), []);
        }
    });
    it('un programme du disque garde sa dérive, même à nom nu', () => {
        expectRules(evaluateSnapshot(ctx({ snapshot: snap([proc({ name: 'sshd', kernel: false })]) })), [
            'process.new'
        ]);
    });
    it('USURPATION : nom de fil du noyau porté par un binaire du disque', () => {
        expectRules(
            evaluateSnapshot(
                ctx({ snapshot: snap([proc({ name: 'kworker/0:1', execPath: '/tmp/kworker', kernel: false })]) })
            ),
            ['exec.masquerade', 'exec.suspicious_path', 'process.new']
        );
    });
});

describe('Ports éphémères', () => {
    const firefox = (listenPorts: number[]) =>
        proc({ name: 'firefox', execPath: '/usr/lib64/firefox/firefox', user: 'www-data', listenPorts });

    it('un port attribué par le système ne fait pas une nouvelle écoute', () => {
        expectRules(
            evaluateSnapshot(
                ctx({
                    snapshot: snap([firefox([45231])]),
                    baseline: known('firefox|/usr/lib64/firefox/firefox')
                })
            ),
            []
        );
    });
    it('un port choisi, lui, se signale toujours', () => {
        expectRules(
            evaluateSnapshot(
                ctx({
                    snapshot: snap([firefox([4444, 45231])]),
                    baseline: known('firefox|/usr/lib64/firefox/firefox')
                })
            ),
            ['process.new_listener']
        );
    });
});

describe('Règles de posture', () => {
    it('pare-feu éteint + SSH root + mots de passe', () => {
        expectRules(
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
    });
    it('sondes toutes à null : AUCUN constat (pas de fausse assurance)', () => {
        expectRules(evaluateReport(ctx({ report: report() })), []);
    });
});

describe('Séparation des cadences', () => {
    // Le rapport arrive une fois par heure, l'instant toutes les soixante secondes.
    // Constater la posture à chaque lot de métriques compterait des tours de moteur
    // dans « constaté n fois » : ces deux assertions tiennent la frontière.
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
    it('un instant banal ne rejoue RIEN de ce que porte le rapport', () => {
        expectRules(
            evaluateSnapshot(
                ctx({
                    snapshot: snap([proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'www-data' })]),
                    baseline: known('nginx|/usr/sbin/nginx'),
                    report: posture
                })
            ),
            []
        );
    });
    it('un rapport ne rejoue AUCUNE règle d’instant (sinon il les résoudrait toutes)', () => {
        expectRules(evaluateReport(ctx({ snapshot: null, report: posture })), [
            'net.mining_pool',
            'port.exposed',
            'posture.firewall_off',
            'posture.ssh_root_login',
            'posture.ssh_password_auth'
        ]);
    });
});

describe('Règles de persistance', () => {
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

    it('nouvelle entrée cron', () => {
        expectRules(persistenceRules(ctx(), [entry({ path: '/etc/cron.d/zz-test', sha256: 'a'.repeat(64) })], false), [
            'persistence.added'
        ]);
    });
    it('empreinte changée', () => {
        expectRules(
            persistenceRules(
                ctx({ baseline: withPersistence('/etc/cron.d/backup', 'b'.repeat(64)) }),
                [entry({ path: '/etc/cron.d/backup', sha256: 'c'.repeat(64) })],
                false
            ),
            ['persistence.modified']
        );
    });
    it('manifeste tronqué : aucune suppression signalée', () => {
        expectRules(
            persistenceRules(ctx({ baseline: withPersistence('/etc/cron.d/gone', 'd'.repeat(64)) }), [], true),
            []
        );
    });
    it('manifeste complet : suppression signalée', () => {
        expectRules(
            persistenceRules(ctx({ baseline: withPersistence('/etc/cron.d/gone', 'd'.repeat(64)) }), [], false),
            ['persistence.removed']
        );
    });
});

describe('Règles d’authentification', () => {
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
    it('tentatives répétées', () => {
        expectRules(
            authRules(
                ctx(),
                authWin({ topSources: [{ address: '1.2.3.4', failed: 42, accepted: 0, users: ['root'] }] })
            ),
            ['auth.bruteforce']
        );
    });
    it('réussite après échecs', () => {
        expectRules(
            authRules(
                ctx(),
                authWin({ topSources: [{ address: '1.2.3.4', failed: 6, accepted: 1, users: ['deploy'] }] })
            ),
            ['auth.success_after_failures']
        );
    });
    it('création de compte', () => {
        expectRules(authRules(ctx(), authWin({ newAccounts: ['backdoor'] })), ['auth.new_account']);
    });
    it('journal illisible : AUCUN constat (pas de fausse tranquillité)', () => {
        expectRules(
            authRules(
                ctx(),
                authWin({ unavailable: true, topSources: [{ address: '1.2.3.4', failed: 99, accepted: 1, users: [] }] })
            ),
            []
        );
    });
});

describe('Clé de programme', () => {
    it('clé avec chemin', () => {
        assert.equal(processKey(proc({ name: 'nginx', execPath: '/usr/sbin/nginx' })), 'nginx|/usr/sbin/nginx');
    });
    it('clé sans chemin retombe sur le nom', () => {
        assert.equal(processKey(proc({ name: 'nginx', execPath: null })), 'nginx');
    });
});
