import type { DeviceReport } from '@deveye/types';
import { FeatureError, type SdkDevice, type SdkFeatureContext } from '@deveye/types/sdk/server';

import {
    SENTINEL_RULES,
    SEVERITY_BY_RANK,
    type AllowEntry,
    type DevicePosture,
    type DeviceSentinelState,
    type EvidenceItem,
    type Finding,
    type PostureCheck,
    type PostureStatus,
    type RuleProbe,
    type SentinelRuleId,
    type SeverityCounts
} from '../contracts/domain';
import { DEFAULT_SENTINEL_INTEGRITY_MINUTES } from '@deveye/types/sdk';

import type { SentinelEngine } from './engine';
import type { AllowRow, DeviceConfigRow, FindingRow, SentinelRepo } from './repo';

export type Ctx = SdkFeatureContext<SentinelRepo>;

/**
 * Briques partagées par les commandes : posture, mise en forme des constats et
 * des états, noms d'appareils. L'accès à un appareil ne se décide pas ici : il
 * passe par `ctx.deveye.devices.authorize`, et le périmètre par
 * `ctx.deveye.devices.list()`.
 */

/**
 * Le moteur, posé par `createService` au démarrage : unique par processus.
 * Seule `sentinel.resetBaseline` lui parle ; les lectures passent par les
 * dépôts, jamais par lui, pour qu'une réponse ne dépende pas d'un tour de boucle.
 */
let engineRef: SentinelEngine | null = null;

export function setEngine(engine: SentinelEngine | null): void {
    engineRef = engine;
}

/** Le moteur, ou une erreur typée quand le serveur tourne sans lui (tests). */
export function engine(): SentinelEngine {
    if (!engineRef) throw new FeatureError('internal', 'Sentinelle indisponible');
    return engineRef;
}

/**
 * Les noms des appareils que cet espace voit, par identifiant : les dépôts ne
 * joignent pas `devices`, constats et autorisations retrouvent leur nom ici.
 */
export function deviceNames(devices: readonly SdkDevice[]): Map<string, string> {
    return new Map(devices.map((d) => [d.id, d.name]));
}

/**
 * Un appareil disparu ou hors périmètre se nomme par son identifiant tronqué :
 * un blanc se lirait comme une donnée cassée.
 */
export function nameOf(names: ReadonlyMap<string, string>, deviceId: string): string {
    return names.get(deviceId) ?? deviceId.slice(0, 8);
}

export function toFinding(row: FindingRow, deviceName: string): Finding {
    return {
        id: row.id,
        deviceId: row.device_id,
        deviceName,
        rule: row.rule,
        severity: SEVERITY_BY_RANK[row.severity] ?? 'info',
        state: row.state,
        subject: row.subject,
        evidence: Array.isArray(row.evidence) ? row.evidence : ([] as EvidenceItem[]),
        snapshotTs: row.snapshot_ts,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        occurrences: row.occurrences,
        ackedBy: row.acked_by,
        ackedAt: row.acked_at
    };
}

/** `deviceName` est `null` pour une autorisation à portée flotte. */
export function toAllow(row: AllowRow, deviceName: string | null): AllowEntry {
    return {
        id: row.id,
        deviceId: row.device_id,
        deviceName,
        rule: row.rule,
        subject: row.subject,
        reason: row.reason,
        createdBy: row.created_by,
        created: row.created
    };
}

/** L'état d'une machine dans la vue de flotte ; `config` à `null` : machine non surveillée, valeurs par défaut. */
/** Un appareil sans constat ouvert : le décompte groupé ne rend pas de ligne pour lui. */
export const EMPTY_COUNTS: SeverityCounts = { info: 0, low: 0, high: 0, critical: 0 };

export function stateOf(device: SdkDevice, config: DeviceConfigRow | null, open: SeverityCounts): DeviceSentinelState {
    const learningUntil = config?.learning_until ?? null;
    return {
        deviceId: device.id,
        deviceName: device.name,
        enabled: config?.enabled === 1,
        learning: learningUntil !== null && Date.now() < learningUntil,
        learningUntil,
        open,
        postureScore: posturize(device).score,
        probes: probesOf(device, config),
        lastIntegrityAt: config?.last_integrity_at ?? null,
        integrityMinutes: config?.integrity_minutes ?? DEFAULT_SENTINEL_INTEGRITY_MINUTES,
        authEvents: config === null ? true : config.auth_events === 1,
        pinEvidence: config === null ? true : config.pin_evidence === 1
    };
}

/** Les contrôles de posture, dans l'ordre où ils s'affichent. */
const POSTURE_ORDER: SentinelRuleId[] = [
    'posture.firewall_off',
    'posture.disk_unencrypted',
    'posture.updates_stale',
    'posture.ssh_root_login',
    'posture.ssh_password_auth',
    'posture.sip_off',
    'posture.no_mac',
    'posture.reboot_pending'
];

/**
 * `null` devient `unknown`, jamais `ok` : un vert sur une sonde absente donne
 * une assurance que rien ne soutient.
 */
function fromProbe(value: boolean | null | undefined, failWhen: boolean): PostureStatus {
    if (value === null || value === undefined) return 'unknown';
    return value === failWhen ? 'fail' : 'ok';
}

/**
 * La posture d'une machine, contrôle par contrôle, avec son score. Le score ne
 * porte que sur les contrôles concluants : diluer les `unknown` reviendrait à
 * récompenser une machine qui ne mesure rien.
 */
export function posturize(device: SdkDevice): DevicePosture {
    const report: DeviceReport | null = device.report;
    const security = report?.security ?? null;
    const isMac = (report?.os.name ?? '').toLowerCase().includes('mac');
    const isWindows = (report?.os.name ?? '').toLowerCase().includes('windows');

    const checks: PostureCheck[] = POSTURE_ORDER.map((rule) => {
        const label = SENTINEL_RULES[rule].label;
        if (!security) return { rule, status: 'unknown' as const, label, detail: null };

        switch (rule) {
            case 'posture.firewall_off':
                return { rule, status: fromProbe(security.firewall, false), label, detail: null };
            case 'posture.disk_unencrypted':
                return { rule, status: fromProbe(security.diskEncryption, false), label, detail: null };
            case 'posture.sip_off':
                // SIP n'existe que sur macOS : ailleurs c'est sans objet, pas « inconnu ».
                return {
                    rule,
                    status: isMac ? fromProbe(security.sip, false) : ('not_applicable' as const),
                    label,
                    detail: null
                };
            case 'posture.ssh_root_login':
                return { rule, status: fromProbe(security.sshRootLogin, true), label, detail: null };
            case 'posture.ssh_password_auth':
                return { rule, status: fromProbe(security.sshPasswordAuth, true), label, detail: null };
            case 'posture.reboot_pending':
                return { rule, status: fromProbe(security.rebootRequired, true), label, detail: null };
            case 'posture.no_mac': {
                if (isMac || isWindows) return { rule, status: 'not_applicable' as const, label, detail: null };
                const mac = security.mandatoryAccessControl;
                if (mac === null) return { rule, status: 'unknown' as const, label, detail: null };
                return {
                    rule,
                    status: mac === 'none' ? ('fail' as const) : ('ok' as const),
                    label,
                    detail: mac === 'none' ? null : mac
                };
            }
            case 'posture.updates_stale': {
                const pending = security.pendingSecurityUpdates;
                if (pending === null) return { rule, status: 'unknown' as const, label, detail: null };
                const checkedAt = security.updatesCheckedAt;
                const ageDays = checkedAt === null ? null : Math.floor((Date.now() - checkedAt) / 86400000);
                return {
                    rule,
                    status: pending > 0 ? ('fail' as const) : ('ok' as const),
                    label,
                    detail:
                        pending > 0
                            ? `${pending} correctif${pending > 1 ? 's' : ''}${ageDays === null ? '' : `, contrôlé il y a ${ageDays} j`}`
                            : 'à jour'
                };
            }
            default:
                return { rule, status: 'unknown' as const, label, detail: null };
        }
    });

    const conclusive = checks.filter((c) => c.status === 'ok' || c.status === 'fail');
    const score =
        conclusive.length === 0
            ? null
            : Math.round((conclusive.filter((c) => c.status === 'ok').length / conclusive.length) * 100);

    return { deviceId: device.id, deviceName: device.name, score, checks };
}

/**
 * Les sondes dont on a reçu de la donnée : l'interface distingue « rien à
 * signaler » d'un agent trop ancien pour avoir mesuré quoi que ce soit.
 */
export function probesOf(device: SdkDevice, config: DeviceConfigRow | null): RuleProbe[] {
    const report = device.report;
    const probes: RuleProbe[] = ['snapshot'];
    if (report) probes.push('report');

    // Ce que l'agent déclare savoir faire, et non ce qu'on déduirait de ses
    // valeurs : une sonde en échec rend `null` comme une sonde absente.
    const declared = new Set(report?.agent?.probes ?? []);
    for (const probe of ['execPath', 'posture', 'integrity', 'auth'] as const) {
        if (declared.has(probe)) probes.push(probe);
    }

    // `integrity` ne se confirme qu'à la réception d'un manifeste : un agent peut
    // la déclarer sans avoir encore relevé (premier cycle, 6 h par défaut).
    if (config === null || config.last_integrity_at === null) {
        const i = probes.indexOf('integrity');
        if (i !== -1) probes.splice(i, 1);
    }
    // L'authentification est déclarée par l'agent mais désactivable côté serveur :
    // l'interrupteur du serveur fait foi.
    if (config === null || config.auth_events !== 1) {
        const i = probes.indexOf('auth');
        if (i !== -1) probes.splice(i, 1);
    }
    return probes;
}
