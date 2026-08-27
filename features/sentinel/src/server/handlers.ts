import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
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
    sentinelResolve,
    sentinelScanNow,
    sentinelSetConfig
} from '../contracts/commands';
import { SENTINEL_RULES, type BaselineEntry } from '../contracts/domain';

import { LEARNING_DAYS } from './env';
import { allowSubject } from './repo';
import { deviceNames, engine, nameOf, posturize, stateOf, toAllow, toFinding, type Ctx } from './_shared';

/**
 * Sentinelle : constats, ligne de base, posture, autorisations.
 *
 * Toutes les lectures passent par les dépôts, jamais par le moteur : une
 * réponse ne doit pas dépendre de l'état d'un tour de boucle en cours. Le moteur
 * n'est sollicité que pour oublier son cache après une remise à zéro.
 *
 * L'accès est déclaré commande par commande (`level: read|write`, la feature
 * est implicite) et appliqué par le dispatcheur avant le handler ;
 * l'appartenance de l'appareil est vérifiée par `ctx.deveye.devices.authorize`,
 * la même règle que la feature Appareils.
 */

export const sentinelHandlers = [
    defineSdkFeature({
        ...sentinelOverview,
        handler: async (ctx: Ctx) => {
            const devices = await ctx.deveye.devices.list();
            const ids = devices.map((d) => d.id);

            // Un seul décompte groupé pour la flotte, une seule lecture des
            // réglages, puis un décompte par appareil. Les appareils sont peu
            // nombreux par nature (ce sont des machines, pas des lignes de
            // données) ; c'est le décompte *global* qui devait éviter le N+1,
            // et il l'évite.
            const [open, configs, perDevice] = await Promise.all([
                ctx.repo.findings.openCounts(ids),
                ctx.repo.deviceConfig.forDevices(ids),
                Promise.all(devices.map(async (d) => [d, await ctx.repo.findings.openCounts([d.id])] as const))
            ]);
            const states = perDevice.map(([device, counts]) => stateOf(device, configs.get(device.id) ?? null, counts));

            const scored = states.filter((d) => d.postureScore !== null);
            const fleetScore =
                scored.length === 0
                    ? null
                    : Math.round(scored.reduce((sum, d) => sum + (d.postureScore ?? 0), 0) / scored.length);

            return {
                open,
                fleetScore,
                // Au pire d'abord : c'est la seule question qu'on se pose en ouvrant
                // la page. Les machines non surveillées ferment la marche.
                devices: states.sort((a, b) => {
                    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
                    const severity =
                        b.open.critical * 1000 + b.open.high * 100 - (a.open.critical * 1000 + a.open.high * 100);
                    if (severity !== 0) return severity;
                    return (a.postureScore ?? 101) - (b.postureScore ?? 101);
                })
            };
        }
    }),
    defineSdkFeature({
        ...sentinelCount,
        handler: async (ctx: Ctx) => {
            const ids = (await ctx.deveye.devices.list()).map((d) => d.id);
            const [open, configs] = await Promise.all([
                ctx.repo.findings.openCounts(ids),
                ctx.repo.deviceConfig.forDevices(ids)
            ]);
            return { open, watched: ids.filter((id) => configs.get(id)?.enabled === 1).length };
        }
    }),
    defineSdkFeature({
        ...sentinelFindings,
        handler: async (ctx: Ctx, input) => {
            // Le filtre par appareil passe par `authorize` ; sans appareil
            // précis, le périmètre borne déjà la requête. Dans les deux cas, aucun
            // constat d'une machine qu'on ne voit pas ne peut sortir.
            if (input.deviceId) await ctx.deveye.devices.authorize(input.deviceId);
            const devices = await ctx.deveye.devices.list();
            const names = deviceNames(devices);
            const { rows, total } = await ctx.repo.findings.list({
                workspaceDeviceIds: devices.map((d) => d.id),
                deviceId: input.deviceId,
                state: input.state,
                minSeverity: input.minSeverity,
                rule: input.rule,
                limit: input.limit,
                offset: input.offset
            });
            return { findings: rows.map((row) => toFinding(row, nameOf(names, row.device_id))), total };
        }
    }),
    defineSdkFeature({
        ...sentinelBaseline,
        handler: async (ctx: Ctx, input) => {
            const device = await ctx.deveye.devices.authorize(input.deviceId);
            const [{ rows, total }, allowed] = await Promise.all([
                ctx.repo.baseline.list(device.id, input.kind, input.limit),
                device.workspaceId !== null
                    ? ctx.repo.allow.forDevice(device.workspaceId, device.id)
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
    }),
    defineSdkFeature({
        ...sentinelPosture,
        handler: async (ctx: Ctx, input) => {
            const device = await ctx.deveye.devices.authorize(input.deviceId);
            return { posture: posturize(device) };
        }
    }),
    defineSdkFeature({
        ...sentinelAcknowledge,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.findings.find(input.findingId);
            if (!row) throw new FeatureError('not_found', 'Constat introuvable');
            const device = await ctx.deveye.devices.authorize(row.device_id);
            if (device.workspaceId === null) {
                throw new FeatureError('conflict', "Cet appareil n'appartient plus à aucun espace");
            }

            // L'autorisation **d'abord**, la résolution ensuite. Dans l'autre ordre,
            // un échec d'écriture laisserait un constat clos que rien n'empêcherait
            // de rouvrir au tour suivant, l'utilisateur croirait avoir décidé.
            const allow = await ctx.repo.allow.add({
                workspaceId: device.workspaceId,
                deviceId: input.scope === 'fleet' ? null : device.id,
                rule: row.rule,
                subject: row.subject,
                reason: input.reason,
                createdBy: ctx.userId,
                at: Math.floor(Date.now() / 1000)
            });
            await ctx.repo.findings.acknowledge(row.id, ctx.userId, Date.now());

            ctx.audit({
                action: 'sentinel.acknowledge',
                level: 'warning',
                description: `Constat jugé légitime (${SENTINEL_RULES[row.rule].label}) sur « ${device.name} » : ${row.subject}`,
                metadata: { deviceId: device.id, rule: row.rule, subject: row.subject, scope: input.scope }
            });

            const updated = await ctx.repo.findings.find(row.id);
            return {
                finding: toFinding(updated ?? row, device.name),
                allow: toAllow(allow, allow.device_id === null ? null : device.name)
            };
        }
    }),
    defineSdkFeature({
        ...sentinelResolve,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.findings.find(input.findingId);
            if (!row) throw new FeatureError('not_found', 'Constat introuvable');
            const device = await ctx.deveye.devices.authorize(row.device_id);
            // Un constat acquitté est déjà clos, par une décision plus forte : le
            // « régler » par-dessus effacerait la trace de qui l'a jugé légitime.
            if (row.state !== 'open') {
                throw new FeatureError('conflict', "Ce constat n'est plus ouvert");
            }

            await ctx.repo.findings.resolve(row.id, Date.now());

            ctx.audit({
                action: 'sentinel.resolve',
                description: `Constat marqué réglé (${SENTINEL_RULES[row.rule].label}) sur « ${device.name} » : ${row.subject}`,
                metadata: { deviceId: device.id, rule: row.rule, subject: row.subject }
            });

            const updated = await ctx.repo.findings.find(row.id);
            return { finding: toFinding(updated ?? row, device.name) };
        }
    }),
    defineSdkFeature({
        ...sentinelReopen,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.findings.find(input.findingId);
            if (!row) throw new FeatureError('not_found', 'Constat introuvable');
            const device = await ctx.deveye.devices.authorize(row.device_id);

            // Rouvrir sans retirer l'autorisation ne servirait à rien : le moteur
            // filtrerait de nouveau le constat au tour suivant, et l'utilisateur
            // verrait sa réouverture s'annuler toute seule.
            if (device.workspaceId !== null) {
                await ctx.repo.allow.removeFor(device.workspaceId, device.id, row.rule, row.subject);
            }
            await ctx.repo.findings.reopen(row.id, Date.now());

            ctx.audit({
                action: 'sentinel.reopen',
                description: `Constat rouvert (${SENTINEL_RULES[row.rule].label}) sur « ${device.name} » : ${row.subject}`,
                metadata: { deviceId: device.id, rule: row.rule, subject: row.subject }
            });

            const updated = await ctx.repo.findings.find(row.id);
            return { finding: toFinding(updated ?? row, device.name) };
        }
    }),
    defineSdkFeature({
        ...sentinelAllowlist,
        handler: async (ctx: Ctx, input) => {
            if (input.deviceId) await ctx.deveye.devices.authorize(input.deviceId);
            const [rows, devices] = await Promise.all([
                ctx.repo.allow.list(ctx.workspaceId, input.deviceId),
                ctx.deveye.devices.list()
            ]);
            const names = deviceNames(devices);
            return {
                entries: rows.map((row) => toAllow(row, row.device_id === null ? null : nameOf(names, row.device_id)))
            };
        }
    }),
    defineSdkFeature({
        ...sentinelRemoveAllow,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.allow.find(input.allowId, ctx.workspaceId);
            if (!row) throw new FeatureError('not_found', 'Autorisation introuvable');
            const removed = await ctx.repo.allow.remove(input.allowId, ctx.workspaceId);
            if (removed) {
                ctx.audit({
                    action: 'sentinel.removeAllow',
                    description: `Autorisation retirée (${SENTINEL_RULES[row.rule].label}) : ${row.subject}`,
                    metadata: { rule: row.rule, subject: row.subject, deviceId: row.device_id }
                });
            }
            return { removed };
        }
    }),
    defineSdkFeature({
        ...sentinelSetConfig,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const device = await ctx.deveye.devices.authorize(input.deviceId);
            const current = await ctx.repo.deviceConfig.get(device.id);
            const wasEnabled = current?.enabled === 1;

            // Activer (re)part une fenêtre d'apprentissage. Réactiver une machine
            // déjà surveillée ne la relance pas : ce serait faire taire la dérive
            // sept jours de plus à chaque passage dans les réglages.
            const learningUntil =
                input.enabled && !wasEnabled
                    ? Date.now() + (input.learningDays ?? LEARNING_DAYS) * 86400000
                    : input.learningDays !== null
                      ? Date.now() + input.learningDays * 86400000
                      : undefined;

            await ctx.repo.deviceConfig.set(device.id, {
                enabled: input.enabled,
                ...(learningUntil === undefined ? {} : { learningUntil }),
                ...(input.integrityMinutes === null ? {} : { integrityMinutes: input.integrityMinutes }),
                ...(input.authEvents === null ? {} : { authEvents: input.authEvents })
            });

            const updated = await ctx.repo.deviceConfig.get(device.id);
            if (!updated) throw new FeatureError('internal', 'Réglages écrits mais introuvables');

            // La config est poussée tout de suite **et** rejouée à la reconnexion
            // (`agent/ws.ts`) : un agent hors ligne au moment du changement applique
            // quand même les bons réglages dès son retour (invariant 1 de Monitoring).
            // C'est l'app qui la recompose, en demandant au module sa part.
            await ctx.deveye.agents.pushConfig(device.id);

            ctx.audit({
                action: 'sentinel.setConfig',
                level: 'warning',
                description: `Sentinelle ${input.enabled ? 'activée' : 'désactivée'} sur « ${device.name} »`,
                metadata: {
                    deviceId: device.id,
                    enabled: input.enabled,
                    integrityMinutes: updated.integrity_minutes,
                    authEvents: updated.auth_events === 1
                }
            });

            return { device: stateOf(device, updated, await ctx.repo.findings.openCounts([device.id])) };
        }
    }),
    defineSdkFeature({
        ...sentinelScanNow,
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => {
            const device = await ctx.deveye.devices.authorize(input.deviceId);
            const config = await ctx.repo.deviceConfig.get(device.id);
            if (config?.enabled !== 1) {
                throw new FeatureError('conflict', "Sentinelle n'est pas active sur cet appareil");
            }
            // `requested: false` quand l'agent est hors ligne : c'est une réponse,
            // pas une erreur, la même convention que `metrics.refresh`.
            return { deviceId: device.id, requested: ctx.deveye.agents.requestScan(device.id) };
        }
    }),
    defineSdkFeature({
        ...sentinelResetBaseline,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const device = await ctx.deveye.devices.authorize(input.deviceId);
            // Le moteur d'abord : sans lui la remise à zéro n'aurait d'effet qu'au
            // prochain redémarrage, autant le dire avant d'avoir effacé quoi que
            // ce soit.
            const running = engine();
            const cleared = await ctx.repo.baseline.reset(device.id);

            // Le moteur tient la ligne de base en mémoire : sans cet oubli, il
            // continuerait de comparer à ce qu'on vient d'effacer, et la remise à
            // zéro n'aurait d'effet qu'au prochain redémarrage du serveur.
            running.invalidate(device.id);

            // Repartir d'une ligne de base vide sans réapprentissage ferait sonner
            // toute la machine au tour suivant. Les autorisations, elles, survivent :
            // ce sont des décisions, pas des observations.
            await ctx.repo.deviceConfig.set(device.id, {
                learningUntil: Date.now() + LEARNING_DAYS * 86400000
            });

            ctx.audit({
                action: 'sentinel.resetBaseline',
                level: 'warning',
                description: `Ligne de base remise à zéro sur « ${device.name} » (${cleared} entrées)`,
                metadata: { deviceId: device.id, cleared }
            });

            return { deviceId: device.id, cleared };
        }
    })
];
