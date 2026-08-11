import {
    DEFAULT_SENTINEL_LEARNING_DAYS,
    SENTINEL_RULES,
    sentinelAcknowledge,
    sentinelAllowlist,
    sentinelBaseline,
    sentinelCount,
    sentinelFindings,
    sentinelOverview,
    sentinelPosture,
    sentinelRemoveAllow,
    sentinelReopen,
    sentinelResetBaseline,
    sentinelScanNow,
    sentinelSetConfig,
    type AllowEntry,
    type BaselineEntry,
    type DeviceRow,
    type DeviceSentinelState
} from 'deveye-types';

import { deviceAgentConfig } from '@/agent/mappers';
import { env } from '@/Utils/Env';
import { allowSubject, type AllowRow } from '@/db/repos/sentinel';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { authorizeDevice } from '../devices/shared';
import { posturize, probesOf, scopedDevices, toFinding } from './_shared';

/**
 * Sentinelle : constats, ligne de base, posture, autorisations.
 *
 * Toutes les lectures passent par les dépôts, jamais par le moteur : une
 * réponse ne doit pas dépendre de l'état d'un tour de boucle en cours. Le moteur
 * n'est sollicité que pour oublier son cache après une remise à zéro.
 *
 * L'accès est déclaré commande par commande (`sentinel: read|write`) et appliqué
 * par le dispatcheur avant le handler ; l'appartenance de l'appareil est
 * vérifiée par `authorizeDevice`, partagé avec la feature Appareils.
 */

function stateOf(row: DeviceRow, open: DeviceSentinelState['open']): DeviceSentinelState {
    const learningUntil = row.sentinel_learning_until === null ? null : Number(row.sentinel_learning_until);
    return {
        deviceId: row.id,
        deviceName: row.name,
        enabled: row.sentinel_enabled === 1,
        learning: learningUntil !== null && Date.now() < learningUntil,
        learningUntil,
        open,
        postureScore: posturize(row).score,
        probes: probesOf(row),
        lastIntegrityAt: row.sentinel_last_integrity_at === null ? null : Number(row.sentinel_last_integrity_at)
    };
}

function toAllow(row: AllowRow): AllowEntry {
    return {
        id: row.id,
        deviceId: row.device_id,
        deviceName: row.device_name,
        rule: row.rule,
        subject: row.subject,
        reason: row.reason,
        createdBy: row.created_by,
        created: row.created
    };
}

export const sentinelOverviewFeature: FeatureDefinition<
    typeof sentinelOverview.command,
    typeof sentinelOverview.input,
    typeof sentinelOverview.output
> = defineFeature({
    ...sentinelOverview,
    access: { feature: 'sentinel', level: 'read' },
    handler: async (ctx) => {
        const devices = await scopedDevices(ctx);
        const ids = devices.map((d) => d.id);

        // Un seul décompte groupé pour la flotte, puis un par appareil. Les
        // appareils sont peu nombreux par nature (ce sont des machines, pas des
        // lignes de données) ; c'est le décompte *global* qui devait éviter le
        // N+1, et il l'évite.
        const [open, perDevice] = await Promise.all([
            ctx.db.findings.openCounts(ids),
            Promise.all(devices.map(async (row) => stateOf(row, await ctx.db.findings.openCounts([row.id]))))
        ]);

        const scored = perDevice.filter((d) => d.postureScore !== null);
        const fleetScore =
            scored.length === 0
                ? null
                : Math.round(scored.reduce((sum, d) => sum + (d.postureScore ?? 0), 0) / scored.length);

        return {
            open,
            fleetScore,
            // Au pire d'abord : c'est la seule question qu'on se pose en ouvrant
            // la page. Les machines non surveillées ferment la marche.
            devices: perDevice.sort((a, b) => {
                if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
                const severity =
                    b.open.critical * 1000 + b.open.high * 100 - (a.open.critical * 1000 + a.open.high * 100);
                if (severity !== 0) return severity;
                return (a.postureScore ?? 101) - (b.postureScore ?? 101);
            })
        };
    }
});

export const sentinelCountFeature: FeatureDefinition<
    typeof sentinelCount.command,
    typeof sentinelCount.input,
    typeof sentinelCount.output
> = defineFeature({
    ...sentinelCount,
    access: { feature: 'sentinel', level: 'read' },
    handler: async (ctx) => {
        const devices = await scopedDevices(ctx);
        const open = await ctx.db.findings.openCounts(devices.map((d) => d.id));
        return { open, watched: devices.filter((d) => d.sentinel_enabled === 1).length };
    }
});

export const sentinelFindingsFeature: FeatureDefinition<
    typeof sentinelFindings.command,
    typeof sentinelFindings.input,
    typeof sentinelFindings.output
> = defineFeature({
    ...sentinelFindings,
    access: { feature: 'sentinel', level: 'read' },
    handler: async (ctx, input) => {
        // Le filtre par appareil passe par `authorizeDevice` ; sans appareil
        // précis, le périmètre borne déjà la requête. Dans les deux cas, aucun
        // constat d'une machine qu'on ne voit pas ne peut sortir.
        if (input.deviceId) await authorizeDevice(ctx, input.deviceId);
        const devices = await scopedDevices(ctx);
        const { rows, total } = await ctx.db.findings.list({
            workspaceDeviceIds: devices.map((d) => d.id),
            deviceId: input.deviceId,
            state: input.state,
            minSeverity: input.minSeverity,
            rule: input.rule,
            limit: input.limit,
            offset: input.offset
        });
        return { findings: rows.map(toFinding), total };
    }
});

export const sentinelBaselineFeature: FeatureDefinition<
    typeof sentinelBaseline.command,
    typeof sentinelBaseline.input,
    typeof sentinelBaseline.output
> = defineFeature({
    ...sentinelBaseline,
    access: { feature: 'sentinel', level: 'read' },
    handler: async (ctx, input) => {
        const device = await authorizeDevice(ctx, input.deviceId);
        const [{ rows, total }, allowed] = await Promise.all([
            ctx.db.baseline.list(device.id, input.kind, input.limit),
            device.workspace_id
                ? ctx.db.sentinelAllow.forDevice(device.workspace_id, device.id)
                : Promise.resolve(new Set<string>())
        ]);
        const entries: BaselineEntry[] = rows.map((row) => ({
            kind: row.kind,
            key: row.item_key,
            firstSeen: row.first_seen,
            lastSeen: row.last_seen,
            samples: row.samples,
            attrs:
                typeof row.attrs === 'string'
                    ? { users: [], listenPorts: [], cpuP95: null, memP95: null, sha256: null, surface: null }
                    : row.attrs,
            // Une entrée « autorisée » l'est pour une règle donnée ; on affiche
            // le drapeau dès qu'une règle la couvre, ce qui est la question que
            // l'utilisateur se pose devant l'inventaire. Le sujet se lit via
            // `allowSubject` : le séparateur de clé est un octet invisible, et
            // le retaper ici serait une erreur qu'aucune relecture n'attraperait.
            allowed: [...allowed].some((key) => allowSubject(key) === row.item_key)
        }));
        return { deviceId: device.id, entries, total };
    }
});

export const sentinelPostureFeature: FeatureDefinition<
    typeof sentinelPosture.command,
    typeof sentinelPosture.input,
    typeof sentinelPosture.output
> = defineFeature({
    ...sentinelPosture,
    access: { feature: 'sentinel', level: 'read' },
    handler: async (ctx, input) => {
        const device = await authorizeDevice(ctx, input.deviceId);
        return { posture: posturize(device) };
    }
});

export const sentinelAcknowledgeFeature: FeatureDefinition<
    typeof sentinelAcknowledge.command,
    typeof sentinelAcknowledge.input,
    typeof sentinelAcknowledge.output
> = defineFeature({
    ...sentinelAcknowledge,
    mutates: true,
    access: { feature: 'sentinel', level: 'write' },
    handler: async (ctx, input) => {
        const row = await ctx.db.findings.find(input.findingId);
        if (!row) throw new FeatureError('not_found', 'Constat introuvable');
        const device = await authorizeDevice(ctx, row.device_id);
        if (!device.workspace_id) {
            throw new FeatureError('conflict', "Cet appareil n'appartient plus à aucun espace");
        }

        // L'autorisation **d'abord**, la résolution ensuite. Dans l'autre ordre,
        // un échec d'écriture laisserait un constat clos que rien n'empêcherait
        // de rouvrir au tour suivant — l'utilisateur croirait avoir décidé.
        const allow = await ctx.db.sentinelAllow.add({
            workspaceId: device.workspace_id,
            deviceId: input.scope === 'fleet' ? null : device.id,
            rule: row.rule,
            subject: row.subject,
            reason: input.reason,
            createdBy: ctx.userId,
            at: Math.floor(Date.now() / 1000)
        });
        await ctx.db.findings.acknowledge(row.id, ctx.userId, Date.now());

        ctx.audit({
            action: 'sentinel.acknowledge',
            level: 'warning',
            description: `Constat jugé légitime (${SENTINEL_RULES[row.rule].label}) sur « ${device.name} » : ${row.subject}`,
            metadata: { deviceId: device.id, rule: row.rule, subject: row.subject, scope: input.scope }
        });

        const updated = await ctx.db.findings.find(row.id);
        return { finding: toFinding(updated ?? row), allow: toAllow(allow) };
    }
});

export const sentinelReopenFeature: FeatureDefinition<
    typeof sentinelReopen.command,
    typeof sentinelReopen.input,
    typeof sentinelReopen.output
> = defineFeature({
    ...sentinelReopen,
    mutates: true,
    access: { feature: 'sentinel', level: 'write' },
    handler: async (ctx, input) => {
        const row = await ctx.db.findings.find(input.findingId);
        if (!row) throw new FeatureError('not_found', 'Constat introuvable');
        const device = await authorizeDevice(ctx, row.device_id);

        // Rouvrir sans retirer l'autorisation ne servirait à rien : le moteur
        // filtrerait de nouveau le constat au tour suivant, et l'utilisateur
        // verrait sa réouverture s'annuler toute seule.
        if (device.workspace_id) {
            await ctx.db.sentinelAllow.removeFor(device.workspace_id, device.id, row.rule, row.subject);
        }
        await ctx.db.findings.reopen(row.id, Date.now());

        ctx.audit({
            action: 'sentinel.reopen',
            description: `Constat rouvert (${SENTINEL_RULES[row.rule].label}) sur « ${device.name} » : ${row.subject}`,
            metadata: { deviceId: device.id, rule: row.rule, subject: row.subject }
        });

        const updated = await ctx.db.findings.find(row.id);
        return { finding: toFinding(updated ?? row) };
    }
});

export const sentinelAllowlistFeature: FeatureDefinition<
    typeof sentinelAllowlist.command,
    typeof sentinelAllowlist.input,
    typeof sentinelAllowlist.output
> = defineFeature({
    ...sentinelAllowlist,
    access: { feature: 'sentinel', level: 'read' },
    handler: async (ctx, input) => {
        if (input.deviceId) await authorizeDevice(ctx, input.deviceId);
        const rows = await ctx.db.sentinelAllow.list(ctx.workspaceId, input.deviceId);
        return { entries: rows.map(toAllow) };
    }
});

export const sentinelRemoveAllowFeature: FeatureDefinition<
    typeof sentinelRemoveAllow.command,
    typeof sentinelRemoveAllow.input,
    typeof sentinelRemoveAllow.output
> = defineFeature({
    ...sentinelRemoveAllow,
    mutates: true,
    access: { feature: 'sentinel', level: 'write' },
    handler: async (ctx, input) => {
        const row = await ctx.db.sentinelAllow.find(input.allowId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Autorisation introuvable');
        const removed = await ctx.db.sentinelAllow.remove(input.allowId, ctx.workspaceId);
        if (removed) {
            ctx.audit({
                action: 'sentinel.removeAllow',
                description: `Autorisation retirée (${SENTINEL_RULES[row.rule].label}) : ${row.subject}`,
                metadata: { rule: row.rule, subject: row.subject, deviceId: row.device_id }
            });
        }
        return { removed };
    }
});

export const sentinelSetConfigFeature: FeatureDefinition<
    typeof sentinelSetConfig.command,
    typeof sentinelSetConfig.input,
    typeof sentinelSetConfig.output
> = defineFeature({
    ...sentinelSetConfig,
    mutates: true,
    access: { feature: 'sentinel', level: 'write' },
    handler: async (ctx, input) => {
        const device = await authorizeDevice(ctx, input.deviceId);
        const wasEnabled = device.sentinel_enabled === 1;

        // Activer (re)part une fenêtre d'apprentissage. Réactiver une machine
        // déjà surveillée ne la relance pas : ce serait faire taire la dérive
        // sept jours de plus à chaque passage dans les réglages.
        const learningUntil =
            input.enabled && !wasEnabled
                ? Date.now() + (input.learningDays ?? env.SENTINEL_LEARNING_DAYS) * 86400000
                : input.learningDays !== null
                  ? Date.now() + input.learningDays * 86400000
                  : undefined;

        await ctx.db.devices.setSentinelConfig(device.id, {
            enabled: input.enabled,
            ...(learningUntil === undefined ? {} : { learningUntil }),
            ...(input.integrityMinutes === null ? {} : { integrityMinutes: input.integrityMinutes }),
            ...(input.authEvents === null ? {} : { authEvents: input.authEvents })
        });

        const updated = await ctx.db.devices.findById(device.id);
        if (!updated) throw new FeatureError('not_found', 'Appareil introuvable');

        // La config est poussée tout de suite **et** rejouée à la reconnexion
        // (`agent/ws.ts`) : un agent hors ligne au moment du changement applique
        // quand même les bons réglages dès son retour (invariant 1 de Monitoring).
        ctx.monitor?.pushConfig(device.id, deviceAgentConfig(updated));

        ctx.audit({
            action: 'sentinel.setConfig',
            level: 'warning',
            description: `Sentinelle ${input.enabled ? 'activée' : 'désactivée'} sur « ${device.name} »`,
            metadata: {
                deviceId: device.id,
                enabled: input.enabled,
                integrityMinutes: updated.sentinel_integrity_minutes,
                authEvents: updated.sentinel_auth_events === 1
            }
        });

        return { device: stateOf(updated, await ctx.db.findings.openCounts([device.id])) };
    }
});

export const sentinelScanNowFeature: FeatureDefinition<
    typeof sentinelScanNow.command,
    typeof sentinelScanNow.input,
    typeof sentinelScanNow.output
> = defineFeature({
    ...sentinelScanNow,
    access: { feature: 'sentinel', level: 'write' },
    handler: async (ctx, input) => {
        const device = await authorizeDevice(ctx, input.deviceId);
        if (device.sentinel_enabled !== 1) {
            throw new FeatureError('conflict', "Sentinelle n'est pas active sur cet appareil");
        }
        // `requested: false` quand l'agent est hors ligne : c'est une réponse,
        // pas une erreur — la même convention que `metrics.refresh`.
        return { deviceId: device.id, requested: ctx.monitor?.requestScan(device.id) ?? false };
    }
});

export const sentinelResetBaselineFeature: FeatureDefinition<
    typeof sentinelResetBaseline.command,
    typeof sentinelResetBaseline.input,
    typeof sentinelResetBaseline.output
> = defineFeature({
    ...sentinelResetBaseline,
    mutates: true,
    access: { feature: 'sentinel', level: 'write' },
    handler: async (ctx, input) => {
        const device = await authorizeDevice(ctx, input.deviceId);
        const cleared = await ctx.db.baseline.reset(device.id);

        // Le moteur tient la ligne de base en mémoire : sans cet oubli, il
        // continuerait de comparer à ce qu'on vient d'effacer, et la remise à
        // zéro n'aurait d'effet qu'au prochain redémarrage du serveur.
        ctx.sentinel?.invalidate(device.id);

        // Repartir d'une ligne de base vide sans réapprentissage ferait sonner
        // toute la machine au tour suivant. Les autorisations, elles, survivent :
        // ce sont des décisions, pas des observations.
        await ctx.db.devices.setSentinelConfig(device.id, {
            learningUntil: Date.now() + (env.SENTINEL_LEARNING_DAYS || DEFAULT_SENTINEL_LEARNING_DAYS) * 86400000
        });

        ctx.audit({
            action: 'sentinel.resetBaseline',
            level: 'warning',
            description: `Ligne de base remise à zéro sur « ${device.name} » (${cleared} entrées)`,
            metadata: { deviceId: device.id, cleared }
        });

        return { deviceId: device.id, cleared };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- même forme que les autres registres de feature
export const sentinelFeatures: FeatureDefinition<string, any, any>[] = [
    sentinelOverviewFeature,
    sentinelCountFeature,
    sentinelFindingsFeature,
    sentinelBaselineFeature,
    sentinelPostureFeature,
    sentinelAcknowledgeFeature,
    sentinelReopenFeature,
    sentinelAllowlistFeature,
    sentinelRemoveAllowFeature,
    sentinelSetConfigFeature,
    sentinelScanNowFeature,
    sentinelResetBaselineFeature
];
