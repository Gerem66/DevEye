import {
    SENTINEL_RULES,
    SEVERITY_BY_RANK,
    type DevicePosture,
    type DeviceReport,
    type DeviceRow,
    type EvidenceItem,
    type Finding,
    type PostureCheck,
    type PostureStatus,
    type RuleProbe,
    type SentinelRuleId
} from '@deveye/types';

import { parseDeviceReport } from '@/agent/mappers';
import type { FindingRow } from '@/db/repos/sentinel';
import type { FeatureContext } from '../_define';

/**
 * Briques partagées par les commandes de Sentinelle : le calcul de posture, la
 * mise en forme des constats, et la résolution du périmètre d'appareils.
 *
 * L'autorisation, elle, n'est **pas** ici : elle passe par `authorizeDevice` de
 * `devices/shared.ts`, comme toutes les autres features qui touchent un appareil
 * (invariant 9 de Monitoring — aucune feature ne refait la logique d'accès).
 */

/**
 * Les appareils que cet espace voit.
 *
 * Même règle que `device.list` : l'administrateur dans son espace **personnel**
 * voit la flotte entière (c'est là qu'il surveille ses machines, et l'obliger à
 * se partager chaque appareil à lui-même n'aurait rien protégé) ; partout
 * ailleurs, on s'en tient au partage explicite.
 */
export async function scopedDevices(ctx: FeatureContext): Promise<DeviceRow[]> {
    if (ctx.isAdmin && ctx.workspace.kind === 'personal') return ctx.db.devices.listAll();
    return ctx.db.devices.listByWorkspace(ctx.workspaceId);
}

/** Rend le DTO d'un constat depuis sa ligne. */
export function toFinding(row: FindingRow): Finding {
    return {
        id: row.id,
        deviceId: row.device_id,
        deviceName: row.device_name,
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
 * Traduit un booléen de sonde en état de contrôle.
 *
 * `null` devient `unknown`, jamais `ok`. C'est la règle qui compte dans tout ce
 * fichier : un tableau de bord qui affiche un vert sur une sonde absente donne
 * une assurance que rien ne soutient.
 */
function fromProbe(value: boolean | null | undefined, failWhen: boolean): PostureStatus {
    if (value === null || value === undefined) return 'unknown';
    return value === failWhen ? 'fail' : 'ok';
}

/**
 * La posture d'une machine, contrôle par contrôle, avec son score.
 *
 * Le score ne porte que sur les contrôles **concluants**. Diluer les `unknown`
 * dans la moyenne reviendrait à récompenser une machine qui ne mesure rien, ce
 * qui est l'exact opposé de ce qu'un score de posture doit encourager.
 */
export function posturize(row: DeviceRow): DevicePosture {
    const report: DeviceReport | null = parseDeviceReport(row.report_json);
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
                // SIP n'existe que sur macOS : ailleurs, ce n'est pas « inconnu »,
                // c'est sans objet — et les deux ne se disent pas pareil.
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

    return { deviceId: row.id, deviceName: row.name, score, checks };
}

/**
 * Les sondes dont on a réellement reçu de la donnée.
 *
 * Sert à l'interface pour distinguer « rien à signaler » de « pas encore
 * mesuré ». Une machine dont l'agent n'a pas encore la version qui remonte les
 * chemins d'exécutables doit le **dire**, plutôt que de laisser croire que les
 * règles `exec.*` l'ont blanchie.
 */
export function probesOf(row: DeviceRow): RuleProbe[] {
    const report = parseDeviceReport(row.report_json);
    const probes: RuleProbe[] = ['snapshot'];
    if (report) probes.push('report');

    // Ce que l'agent **déclare** savoir faire, et non ce qu'on déduirait de ses
    // valeurs : une sonde en échec rend `null` exactement comme une sonde
    // absente, et les confondre reviendrait à conseiller d'aller inspecter une
    // machine dont l'agent a simplement besoin d'être mis à jour.
    const declared = new Set(report?.agent?.probes ?? []);
    for (const probe of ['execPath', 'posture', 'integrity', 'auth'] as const) {
        if (declared.has(probe)) probes.push(probe);
    }

    // `integrity` se confirme à la réception d'un manifeste : un agent peut la
    // déclarer et n'avoir pas encore relevé (premier cycle, 6 h par défaut).
    if (row.sentinel_last_integrity_at === null) {
        const i = probes.indexOf('integrity');
        if (i !== -1) probes.splice(i, 1);
    }
    // Idem pour l'authentification : déclarée par l'agent, mais désactivable
    // côté serveur. L'interrupteur du serveur fait foi.
    if (row.sentinel_auth_events !== 1) {
        const i = probes.indexOf('auth');
        if (i !== -1) probes.splice(i, 1);
    }
    return probes;
}
