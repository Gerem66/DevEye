import {
    SENTINEL_RULES,
    type AuthWindow,
    type DeviceReport,
    type EvidenceItem,
    type FindingSeverity,
    type PersistenceEntry,
    type ReportProcess,
    type SentinelRuleId
} from 'deveye-types';

import type { BaselineRow } from '@/db/repos/sentinel';

/**
 * Le catalogue de règles de Sentinelle.
 *
 * **Tout ici est une fonction pure.** Aucune règle ne lit la base, n'écrit nulle
 * part, ni ne regarde l'horloge autrement qu'à travers le `now` qu'on lui passe.
 * Ce dépôt n'a pas de cadre de test (`npm test` sort en 1), et c'est cette
 * pureté qui rend les règles vérifiables quand même : on leur fabrique un
 * instant, on regarde ce qu'elles rendent (voir `scripts/check-rules.ts`).
 *
 * ## Ce que ce module expose
 *
 * `evaluateSnapshot` pour l'instant, `persistenceRules` et `authRules` pour les
 * deux relevés qui ont leur propre cadence, plus les clés d'éléments. Les règles
 * qu'`evaluateSnapshot` compose ne sortent pas : ce sont des détails de
 * composition, et les exposer aurait invité à les appeler dans le désordre — or
 * l'ordre et le regroupement font partie de ce que le moteur attend.
 *
 * ## Ce qu'une règle rend
 *
 * Un `FindingDraft`, jamais un effet. C'est le moteur qui décide s'il faut
 * ouvrir, incrémenter ou notifier — une règle qui saurait cela devrait connaître
 * l'état précédent, et deviendrait intestable.
 *
 * ## La discipline du silence
 *
 * Une règle dont la sonde n'a rien dit **ne rend rien**. Elle ne rend surtout
 * pas un constat rassurant : `null` veut dire « je n'ai pas pu regarder », et le
 * confondre avec « tout va bien » est la façon la plus sûre de donner une
 * fausse assurance (invariant 6 de Monitoring).
 */

/** Ce qu'une règle produit. Le moteur y ajoute l'appareil et la date. */
export interface FindingDraft {
    rule: SentinelRuleId;
    severity: FindingSeverity;
    subject: string;
    evidence: EvidenceItem[];
    snapshotTs: number | null;
}

/** L'instant sur lequel les règles d'instant travaillent. */
export interface SnapshotView {
    ts: number;
    processes: ReportProcess[];
    activeConnections: number | null;
}

/** Ce que le moteur pose devant les règles. */
export interface EvalContext {
    now: number;
    /**
     * La fenêtre d'apprentissage court encore. Les règles de dérive se taisent :
     * pendant cette fenêtre, tout ce qu'on voit *est* la normale, par définition.
     */
    learning: boolean;
    snapshot: SnapshotView | null;
    report: DeviceReport | null;
    /** La ligne de base, par nature, indexée sur la clé d'élément. */
    baseline: {
        process: Map<string, BaselineRow>;
        listener: Map<string, BaselineRow>;
        persistence: Map<string, BaselineRow>;
    };
}

function draft(
    rule: SentinelRuleId,
    subject: string,
    evidence: EvidenceItem[],
    snapshotTs: number | null,
    severity?: FindingSeverity
): FindingDraft {
    return {
        rule,
        severity: severity ?? SENTINEL_RULES[rule].severity,
        subject,
        evidence,
        snapshotTs
    };
}

function ev(label: string, value: string | number | null | undefined): EvidenceItem {
    return { label, value: value === null || value === undefined ? '—' : String(value).slice(0, 512) };
}

// ─────────────────────────────── clés d'éléments ─────────────────────────────

/**
 * La clé d'un programme : `nom|chemin`.
 *
 * Le chemin fait partie de la clé, et c'est le point. Agréger sur le seul nom
 * fusionnait deux binaires homonymes rangés à des endroits différents — exactement
 * ce derrière quoi un imposteur se cache. Un agent trop ancien ne renvoie pas de
 * chemin : la clé retombe alors sur le nom seul, et les règles qui dépendent du
 * chemin (`exec.*`) restent muettes plutôt que de conclure sur du vide.
 */
export function processKey(p: ReportProcess): string {
    return p.execPath ? `${p.name}|${p.execPath}` : p.name;
}

/**
 * La clé d'une écoute : `proto/adresse:port`.
 *
 * L'adresse de bind fait partie de la clé parce qu'elle porte l'exposition :
 * `127.0.0.1:8080` et `0.0.0.0:8080` sont deux faits différents, et passer de
 * l'un à l'autre est précisément l'événement qu'on veut voir.
 */
export function listenerKey(proto: string, address: string, port: number): string {
    return `${proto}/${address}:${port}`;
}

// ──────────────────────────────── heuristiques ───────────────────────────────

/**
 * Répertoires où rien ne devrait jamais s'exécuter.
 *
 * Ce sont les points de chute d'un dropper : accessibles en écriture à tous,
 * souvent montés sans `noexec`, et vidés au redémarrage — ce qui en fait aussi
 * un endroit commode pour ne pas laisser de trace.
 */
const SUSPICIOUS_EXEC_PREFIXES = [
    '/tmp/',
    '/var/tmp/',
    '/dev/shm/',
    '/run/shm/',
    '/run/user/',
    '/var/www/',
    '/var/spool/'
];

/** Suffixes de répertoire utilisateur également suspects (caches, corbeilles). */
const SUSPICIOUS_EXEC_FRAGMENTS = ['/.cache/', '/.local/share/Trash/', '/Downloads/'];

/**
 * Ports de pools de minage.
 *
 * Liste courte et assumée : ce sont les ports par défaut des pools les plus
 * répandus. Un mineur peut évidemment en choisir un autre — cette règle attrape
 * le cas paresseux, qui est de très loin le plus fréquent, et `process.new`
 * plus `process.resource_anomaly` couvrent le reste.
 */
const MINING_POOL_PORTS = new Set([3333, 4444, 5555, 7777, 8888, 9000, 14444, 45700]);

/**
 * Interpréteurs et outils réseau qui n'ont normalement rien à faire avec une
 * connexion sortante établie.
 *
 * Un `bash` qui maintient une socket vers l'extérieur est la forme même d'un
 * shell inversé. Les scripts d'administration légitimes existent, d'où
 * l'acquittement — mais le défaut est de le signaler.
 */
const SHELL_NAMES = new Set([
    'sh',
    'bash',
    'dash',
    'zsh',
    'ksh',
    'csh',
    'tcsh',
    'fish',
    'nc',
    'ncat',
    'netcat',
    'socat',
    'telnet'
]);

/** Interpréteurs, reconnus par préfixe (`python3.11`, `perl5.36`, `ruby3.2`). */
const INTERPRETER_PREFIXES = ['python', 'perl', 'ruby', 'php', 'lua', 'tclsh'];

function isShellLike(name: string): boolean {
    const lower = name.toLowerCase();
    if (SHELL_NAMES.has(lower)) return true;
    return INTERPRETER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Noms que le noyau se réserve. Un processus qui les porte **et** vient du
 * disque ment sur ce qu'il est : un fil du noyau n'a pas d'exécutable.
 */
const KERNEL_THREAD_PREFIXES = ['kworker/', 'kthreadd', 'ksoftirqd/', 'migration/', 'rcu_', 'watchdog/'];

function looksLikeKernelThread(name: string): boolean {
    if (name.startsWith('[') && name.endsWith(']')) return true;
    return KERNEL_THREAD_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isSuspiciousPath(path: string): boolean {
    if (SUSPICIOUS_EXEC_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
    return SUSPICIOUS_EXEC_FRAGMENTS.some((fragment) => path.includes(fragment));
}

/** Une adresse de bind joignable depuis l'extérieur de la machine. */
export function isWorldBound(address: string): boolean {
    return address === '0.0.0.0' || address === '::' || address === '*';
}

// ────────────────────────────── règles d'instant ─────────────────────────────

/**
 * Ce qu'un processus révèle de lui-même, indépendamment de son passé.
 *
 * Actives dès le premier instant, y compris pendant l'apprentissage : un binaire
 * qui tourne depuis `/tmp` est anormal le jour 1 comme le jour 100, et attendre
 * sept jours pour le dire n'aurait aucun sens.
 */
function execRules(ctx: EvalContext): FindingDraft[] {
    if (!ctx.snapshot) return [];
    const out: FindingDraft[] = [];
    const ts = ctx.snapshot.ts;

    for (const p of ctx.snapshot.processes) {
        // Sans chemin, rien à dire : l'agent est trop ancien ou n'a pas les
        // droits. On se tait plutôt que de conclure.
        if (p.execPath) {
            if (isSuspiciousPath(p.execPath)) {
                out.push(
                    draft(
                        'exec.suspicious_path',
                        `${p.name}|${p.execPath}`,
                        [
                            ev('Programme', p.name),
                            ev('Chemin', p.execPath),
                            ev('Compte', p.user),
                            ev('Instances', p.instances),
                            ev('CPU', `${p.cpuPercent.toFixed(1)} %`)
                        ],
                        ts
                    )
                );
            }
            if (looksLikeKernelThread(p.name)) {
                out.push(
                    draft(
                        'exec.masquerade',
                        `${p.name}|${p.execPath}`,
                        [ev('Nom affiché', p.name), ev('Chemin réel', p.execPath), ev('Compte', p.user)],
                        ts
                    )
                );
            }
        }
        if (p.deleted === true) {
            out.push(
                draft(
                    'exec.deleted_binary',
                    processKey(p),
                    [
                        ev('Programme', p.name),
                        ev('Chemin effacé', p.execPath),
                        ev('Compte', p.user),
                        ev('Actif depuis', p.uptimeSeconds === null ? null : `${p.uptimeSeconds} s`)
                    ],
                    ts
                )
            );
        }
    }
    return out;
}

/**
 * Ce que le trafic révèle. Comme `execRules`, indépendant de la ligne de base.
 */
function netRules(ctx: EvalContext): FindingDraft[] {
    const out: FindingDraft[] = [];
    const ts = ctx.snapshot?.ts ?? null;

    if (ctx.snapshot) {
        for (const p of ctx.snapshot.processes) {
            // `connOut` à `null` = non mesuré (droits manquants sur les sockets
            // d'autres comptes). Zéro et « inconnu » ne se confondent pas.
            if (isShellLike(p.name) && p.connOut !== null && p.connOut > 0) {
                out.push(
                    draft(
                        'net.shell_outbound',
                        processKey(p),
                        [
                            ev('Programme', p.name),
                            ev('Chemin', p.execPath),
                            ev('Compte', p.user),
                            ev('Connexions sortantes', p.connOut),
                            ev('Instances', p.instances)
                        ],
                        ts
                    )
                );
            }
        }
    }

    return out;
}

/**
 * Les connexions établies, telles que le rapport les porte.
 *
 * Elles vivent dans le rapport et pas dans l'instant : c'est lui qui porte le
 * détail derrière le simple compteur `activeConnections`. La règle est donc
 * rangée avec les autres règles de rapport, à la cadence du rapport — la
 * rejouer à chaque instant la re-constatait toutes les soixante secondes sur
 * une liste de connexions inchangée.
 *
 * L'instant reste utile quand il y en a un : il date le constat, et c'est lui
 * qu'épingle `setInstantsPinned` pour une règle de cette gravité.
 */
function connectionRules(ctx: EvalContext): FindingDraft[] {
    const ts = ctx.snapshot?.ts ?? null;
    const out: FindingDraft[] = [];
    for (const c of ctx.report?.connections ?? []) {
        if (!MINING_POOL_PORTS.has(c.remotePort)) continue;
        out.push(
            draft(
                'net.mining_pool',
                `${c.remoteAddress}:${c.remotePort}`,
                [
                    ev('Pair distant', `${c.remoteAddress}:${c.remotePort}`),
                    ev('Depuis', `${c.localAddress}:${c.localPort}`)
                ],
                ts
            )
        );
    }
    return out;
}

/**
 * Les ports en écoute, confrontés à ce qu'on connaît.
 *
 * `port.unattributed` est la seule des deux à ne pas dépendre de la ligne de
 * base : une écoute sans propriétaire est anormale en soi. Encore faut-il que
 * l'agent ait eu les droits de chercher — sans privilèges, l'absence de `pid`
 * est la normale et n'apprend rien.
 */
function listenerRules(ctx: EvalContext): FindingDraft[] {
    const ports = ctx.report?.openPorts;
    if (!ports) return [];
    const out: FindingDraft[] = [];
    const privileged = ctx.report?.agent?.privileged === true;
    const ts = ctx.snapshot?.ts ?? null;

    for (const port of ports) {
        const key = listenerKey(port.proto, port.address, port.port);

        if (privileged && port.pid === null && port.process === null) {
            out.push(
                draft(
                    'port.unattributed',
                    key,
                    [
                        ev('Port', `${port.proto}/${port.port}`),
                        ev('Adresse', port.address),
                        ev('Propriétaire', 'introuvable malgré les privilèges')
                    ],
                    ts
                )
            );
        }

        if (ctx.learning) continue;
        if (!isWorldBound(port.address)) continue;
        if (ctx.baseline.listener.has(key)) continue;

        out.push(
            draft(
                'port.exposed',
                key,
                [
                    ev('Port', `${port.proto}/${port.port}`),
                    ev('Adresse de bind', `${port.address} (toutes interfaces)`),
                    ev('Programme', port.process),
                    ev('PID', port.pid)
                ],
                ts
            )
        );
    }
    return out;
}

/**
 * La dérive des programmes : ce qui est nouveau, ce qui a changé de compte, ce
 * qui s'est mis à écouter, ce qui consomme hors de son habitude.
 *
 * Entièrement muette pendant l'apprentissage — c'est là toute la différence
 * entre un détecteur utilisable et une liste de trois cents lignes le jour 1.
 */
function processRules(ctx: EvalContext): FindingDraft[] {
    if (ctx.learning || !ctx.snapshot) return [];
    const out: FindingDraft[] = [];
    const ts = ctx.snapshot.ts;

    for (const p of ctx.snapshot.processes) {
        const key = processKey(p);
        const known = ctx.baseline.process.get(key);

        if (!known) {
            out.push(
                draft(
                    'process.new',
                    key,
                    [
                        ev('Programme', p.name),
                        ev('Chemin', p.execPath),
                        ev('Compte', p.user),
                        ev('Instances', p.instances),
                        ev('CPU', `${p.cpuPercent.toFixed(1)} %`),
                        ev('Mémoire', `${Math.round(p.memBytes / 1024 / 1024)} Mo`)
                    ],
                    ts
                )
            );
            // Un programme inconnu ne peut pas dériver de lui-même : les trois
            // règles suivantes n'auraient rien à quoi comparer.
            continue;
        }

        const attrs = typeof known.attrs === 'string' ? null : known.attrs;
        if (!attrs) continue;

        if (p.user && attrs.users.length > 0 && !attrs.users.includes(p.user)) {
            out.push(
                draft(
                    'process.user_changed',
                    key,
                    [
                        ev('Programme', p.name),
                        ev('Chemin', p.execPath),
                        ev('Compte habituel', attrs.users.join(', ')),
                        ev('Compte observé', p.user)
                    ],
                    ts,
                    // Vers root, c'est une élévation de privilèges : la gravité
                    // par défaut ne rendrait pas justice à ce que ça signifie.
                    p.user === 'root' || p.user === 'SYSTEM' ? 'critical' : undefined
                )
            );
        }

        const newPorts = p.listenPorts.filter((port) => !attrs.listenPorts.includes(port));
        if (newPorts.length > 0 && attrs.listenPorts.length >= 0) {
            out.push(
                draft(
                    'process.new_listener',
                    key,
                    [
                        ev('Programme', p.name),
                        ev('Chemin', p.execPath),
                        ev('Nouveaux ports', newPorts.join(', ')),
                        ev('Ports habituels', attrs.listenPorts.length > 0 ? attrs.listenPorts.join(', ') : 'aucun')
                    ],
                    ts
                )
            );
        }

        // Le seuil demande une enveloppe **et** un historique : une p95 tirée de
        // trois instants ne veut rien dire, et se déclencherait sur le premier
        // pic normal.
        if (attrs.cpuP95 !== null && known.samples >= 60 && p.cpuPercent > attrs.cpuP95 * 3 && p.cpuPercent > 20) {
            out.push(
                draft(
                    'process.resource_anomaly',
                    key,
                    [
                        ev('Programme', p.name),
                        ev('CPU observé', `${p.cpuPercent.toFixed(1)} %`),
                        ev('CPU habituel (p95)', `${attrs.cpuP95.toFixed(1)} %`),
                        ev('Instants observés', known.samples)
                    ],
                    ts
                )
            );
        }
    }

    if (ctx.snapshot.activeConnections !== null) {
        // Pas d'enveloppe par appareil pour les connexions : le seuil est
        // volontairement grossier et absolu, parce que la p99 d'une machine au
        // repos est si basse qu'un multiplicateur la ferait sonner pour rien.
        const spike = ctx.snapshot.activeConnections;
        if (spike > 500) {
            out.push(
                draft(
                    'net.connection_spike',
                    'activeConnections',
                    [ev('Connexions établies', spike), ev('Seuil', 500)],
                    ts
                )
            );
        }
    }

    return out;
}

// ─────────────────────────────── règles de posture ───────────────────────────

/**
 * La posture, transformée en constats.
 *
 * Un contrôle dont la sonde rend `null` **ne produit rien** : ni constat, ni
 * assurance. C'est ce qui distingue « le pare-feu est éteint » de « je n'ai pas
 * pu savoir si le pare-feu est allumé », deux phrases qu'un tableau de bord ne
 * doit jamais confondre.
 */
function postureRules(ctx: EvalContext): FindingDraft[] {
    const security = ctx.report?.security;
    if (!security) return [];
    const out: FindingDraft[] = [];
    const os = ctx.report?.os.name ?? '';

    if (security.firewall === false) {
        out.push(draft('posture.firewall_off', 'firewall', [ev('Pare-feu', 'désactivé'), ev('Système', os)], null));
    }
    if (security.diskEncryption === false) {
        out.push(
            draft(
                'posture.disk_unencrypted',
                'diskEncryption',
                [ev('Chiffrement du volume système', 'absent'), ev('Système', os)],
                null
            )
        );
    }
    if (security.sip === false) {
        out.push(draft('posture.sip_off', 'sip', [ev('System Integrity Protection', 'désactivée')], null));
    }
    if (security.sshRootLogin === true) {
        out.push(
            draft(
                'posture.ssh_root_login',
                'sshRootLogin',
                [
                    ev('PermitRootLogin', 'yes'),
                    ev('Conséquence', 'une connexion root réussie ne laisse aucune trace nominative')
                ],
                null
            )
        );
    }
    if (security.sshPasswordAuth === true) {
        out.push(
            draft(
                'posture.ssh_password_auth',
                'sshPasswordAuth',
                [
                    ev('PasswordAuthentication', 'yes'),
                    ev('Conséquence', 'la machine est exposée aux tentatives répétées')
                ],
                null
            )
        );
    }
    if (security.mandatoryAccessControl === 'none') {
        out.push(draft('posture.no_mac', 'mac', [ev('SELinux / AppArmor', 'aucun actif')], null));
    }
    if (security.rebootRequired === true) {
        out.push(
            draft(
                'posture.reboot_pending',
                'rebootRequired',
                [
                    ev('Redémarrage', 'requis pour appliquer des correctifs déjà installés'),
                    ev(
                        'Depuis',
                        ctx.report?.collectedAt && ctx.snapshot
                            ? `${Math.round((ctx.now - ctx.report.collectedAt) / 86400000)} j (dernier rapport)`
                            : null
                    )
                ],
                null
            )
        );
    }

    // Les correctifs de sécurité : c'est leur **ancienneté** qui fait le signal,
    // pas leur nombre. Douze correctifs appliqués dans la journée ne disent rien ;
    // un seul qui attend depuis trois semaines dit tout.
    const pending = security.pendingSecurityUpdates;
    if (pending !== null && pending > 0) {
        const checkedAt = security.updatesCheckedAt;
        const ageDays = checkedAt === null ? null : Math.floor((ctx.now - checkedAt) / 86400000);
        out.push(
            draft(
                'posture.updates_stale',
                'securityUpdates',
                [
                    ev('Correctifs de sécurité en attente', pending),
                    ev('Dernier contrôle', ageDays === null ? null : `il y a ${ageDays} j`),
                    ev('Total des mises à jour', security.pendingUpdates)
                ],
                null
            )
        );
    }

    return out;
}

// ───────────────────────── règles de persistance & auth ──────────────────────

/**
 * Le diff du manifeste de persistance contre ce qu'on connaît.
 *
 * `truncated` coupe les suppressions, et c'est important : un manifeste tronqué
 * ne prouve pas qu'une entrée a disparu, seulement qu'on a cessé de regarder.
 * Émettre `persistence.removed` dans ce cas produirait des centaines de faux
 * constats le jour où une machine dépasse le plafond.
 */
export function persistenceRules(ctx: EvalContext, entries: PersistenceEntry[], truncated: boolean): FindingDraft[] {
    if (ctx.learning) return [];
    const out: FindingDraft[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
        seen.add(entry.path);
        const known = ctx.baseline.persistence.get(entry.path);
        if (!known) {
            out.push(
                draft(
                    'persistence.added',
                    entry.path,
                    [
                        ev('Chemin', entry.path),
                        ev('Surface', entry.surface),
                        ev('Empreinte', entry.sha256.slice(0, 16)),
                        ev('Propriétaire', entry.owner),
                        ev('Droits', entry.mode),
                        ev('Taille', `${entry.sizeBytes} o`)
                    ],
                    null
                )
            );
            continue;
        }
        const attrs = typeof known.attrs === 'string' ? null : known.attrs;
        if (attrs?.sha256 && attrs.sha256 !== entry.sha256) {
            out.push(
                draft(
                    'persistence.modified',
                    entry.path,
                    [
                        ev('Chemin', entry.path),
                        ev('Surface', entry.surface),
                        ev('Empreinte précédente', attrs.sha256.slice(0, 16)),
                        ev('Empreinte actuelle', entry.sha256.slice(0, 16)),
                        ev('Propriétaire', entry.owner)
                    ],
                    null
                )
            );
        }
    }

    if (!truncated) {
        for (const [path, known] of ctx.baseline.persistence) {
            if (seen.has(path)) continue;
            const attrs = typeof known.attrs === 'string' ? null : known.attrs;
            out.push(
                draft(
                    'persistence.removed',
                    path,
                    [
                        ev('Chemin', path),
                        ev('Surface', attrs?.surface),
                        ev('Connu depuis', new Date(known.first_seen).toISOString().slice(0, 10))
                    ],
                    null
                )
            );
        }
    }

    return out;
}

/** Échecs d'une même adresse au-delà desquels on parle de tentatives répétées. */
const BRUTEFORCE_THRESHOLD = 10;

/**
 * Combien d'échecs, depuis une adresse, rendent une réussite ultérieure
 * suspecte. Volontairement plus bas que le seuil de tentatives répétées : ce
 * n'est pas le volume qui compte ici, c'est l'enchaînement.
 */
const SUCCESS_AFTER_FAILURES_THRESHOLD = 5;

/**
 * Les issues d'authentification.
 *
 * Actives sans ligne de base : une création de compte ou une réussite après
 * échecs n'a pas besoin d'habitude pour être anormale. `unavailable` coupe tout —
 * une machine dont on n'a pas pu lire le journal n'est pas une machine tranquille.
 */
// `_ctx` : cette règle n'a besoin ni de la ligne de base ni du rapport, mais
// garde la signature commune du catalogue — toute règle s'appelle de la même
// façon, et celle-ci pourra s'en servir sans changer ses appelants.
export function authRules(_ctx: EvalContext, auth: AuthWindow): FindingDraft[] {
    if (auth.unavailable) return [];
    const out: FindingDraft[] = [];

    for (const source of auth.topSources) {
        if (source.failed >= BRUTEFORCE_THRESHOLD) {
            out.push(
                draft(
                    'auth.bruteforce',
                    source.address,
                    [
                        ev('Adresse', source.address),
                        ev('Échecs', source.failed),
                        ev('Comptes visés', source.users.length > 0 ? source.users.join(', ') : '—'),
                        ev('Fenêtre', `${new Date(auth.from).toISOString()} → ${new Date(auth.to).toISOString()}`)
                    ],
                    null
                )
            );
        }
        // L'enchaînement échecs → réussite, depuis la même adresse et dans la
        // même fenêtre : c'est la signature d'une devinette qui a abouti.
        if (source.accepted > 0 && source.failed >= SUCCESS_AFTER_FAILURES_THRESHOLD) {
            out.push(
                draft(
                    'auth.success_after_failures',
                    source.address,
                    [
                        ev('Adresse', source.address),
                        ev('Échecs avant réussite', source.failed),
                        ev('Réussites', source.accepted),
                        ev('Comptes visés', source.users.length > 0 ? source.users.join(', ') : '—')
                    ],
                    null
                )
            );
        }
    }

    for (const account of auth.newAccounts) {
        out.push(
            draft(
                'auth.new_account',
                account,
                [
                    ev('Compte créé', account),
                    ev('Fenêtre', `${new Date(auth.from).toISOString()} → ${new Date(auth.to).toISOString()}`)
                ],
                null
            )
        );
    }

    if (auth.rootLogins > 0) {
        const rootFrom = auth.logins.filter((l) => l.user === 'root').map((l) => l.address ?? '?');
        out.push(
            draft(
                'auth.root_login',
                'root',
                [
                    ev('Sessions root directes', auth.rootLogins),
                    ev('Origines', rootFrom.length > 0 ? [...new Set(rootFrom)].join(', ') : '—')
                ],
                null
            )
        );
    }

    return out;
}

/**
 * Les règles d'un instant, dans l'ordre où on veut les lire.
 *
 * Persistance et authentification n'y sont pas : elles arrivent sur leurs
 * propres relevés, à leur propre cadence, et les rejouer à chaque instant
 * ferait remonter des constats sur des données inchangées.
 *
 * **Posture et ports non plus, pour exactement la même raison.** Ils ne lisent
 * que `ctx.report`, qui n'arrive qu'au rapport horaire ; les rejouer à chaque
 * lot de métriques réécrivait `last_seen` et incrémentait `occurrences` toutes
 * les soixante secondes sans qu'aucune mesure n'ait eu lieu. L'interface
 * annonçait « constaté il y a 5 min » pour un fait relevé jusqu'à une heure
 * plus tôt, et « constaté 1206 fois » comptait des tours de moteur. Voir
 * `evaluateReport`.
 */
export function evaluateSnapshot(ctx: EvalContext): FindingDraft[] {
    return [...execRules(ctx), ...netRules(ctx), ...processRules(ctx)];
}

/**
 * Les règles nourries par le rapport, à rejouer seulement quand il en arrive un.
 *
 * `connectionRules` lit `ctx.report.connections`, `listenerRules`
 * `ctx.report.openPorts` et `postureRules` `ctx.report.security` : aucune ne
 * regarde l'instant autrement que pour dater son constat.
 */
export function evaluateReport(ctx: EvalContext): FindingDraft[] {
    return [...connectionRules(ctx), ...listenerRules(ctx), ...postureRules(ctx)];
}

/** Les règles qu'`evaluateSnapshot` couvre — celles que le moteur peut résoudre. */
export const SNAPSHOT_RULES: SentinelRuleId[] = [
    'exec.suspicious_path',
    'exec.masquerade',
    'exec.deleted_binary',
    'net.shell_outbound',
    'net.connection_spike',
    'process.new',
    'process.user_changed',
    'process.new_listener',
    'process.resource_anomaly'
];

/** Les règles qu'`evaluateReport` couvre. Même office, autre cadence. */
export const REPORT_RULES: SentinelRuleId[] = [
    'net.mining_pool',
    'port.unattributed',
    'port.exposed',
    'posture.firewall_off',
    'posture.disk_unencrypted',
    'posture.sip_off',
    'posture.ssh_root_login',
    'posture.ssh_password_auth',
    'posture.no_mac',
    'posture.reboot_pending',
    'posture.updates_stale'
];
