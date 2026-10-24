import {
    MODERATION_PROVIDER,
    type ModerationHit,
    type ModerationProvider,
    type ModerationSubject
} from '@deveye/types/sdk';
import {
    isRemoteFailure,
    logFailure,
    safeFetchText,
    type FeatureService,
    type FeatureServiceDeps
} from '@deveye/types/sdk/server';

import { dedupeKeyOf, now, sealHit } from './_shared';
import { env } from './env';
import type { ModerationRepo, RuleRow } from './repo';
import { compileNameRules, coversExposure, parseFingerprints, type CompiledNameRule } from './rules';

/**
 * Le service : le provider que les autres modules consultent, les motifs de
 * nom tenus en mémoire, la liste externe relue toutes les heures et le ménage
 * du journal.
 *
 * Une empreinte se cherche en base à chaque fois (une lecture sur index, et
 * la liste peut compter des centaines de milliers de lignes) ; les motifs de
 * nom, quelques dizaines au plus, se compilent une fois et se relisent à
 * chaque changement de règle, ou toutes les minutes pour ce qu'une autre
 * instance aurait changé.
 */

const NAME_RULES_TTL_MS = 60_000;
const FEED_EVERY_MS = 3_600_000;
const TICK_MS = 60_000;
/** Une détection se garde un an : la trace de ce qui a été arrêté, comme un signalement clos. */
const HIT_RETENTION_SECONDS = 365 * 24 * 3_600;
const PURGE_EVERY_MS = 24 * 3_600_000;
const FEED_MAX_BYTES = 64 * 1024 * 1024;
const FEED_TIMEOUT_MS = 60_000;
export const FEED_LABEL = 'Empreinte de la liste externe de l’instance';
export const META_FEED_AT = 'feed.lastImport';
export const META_FEED_ERROR = 'feed.lastError';

/** Ce que les commandes lisent du service en marche. */
export interface ModerationRuntime {
    /** Les règles ont changé : les motifs de nom se relisent avant la prochaine consultation. */
    rulesChanged(): void;
    feedStatus(): Promise<{ configured: boolean; count: number; lastImport: number | null; lastError: string | null }>;
    /** Relit la liste externe maintenant : ce que « Revérifier » demande. */
    importFeed(): Promise<void>;
}

let runtime: ModerationRuntime | null = null;

export function setRuntime(next: ModerationRuntime | null): void {
    runtime = next;
}

export function moderation(): ModerationRuntime | null {
    return runtime;
}

export function createModerationService(deps: FeatureServiceDeps<ModerationRepo>): FeatureService {
    let nameRules: { at: number; rules: CompiledNameRule<RuleRow>[] } | null = null;
    let lastFeed = 0;
    let lastPurge = 0;
    let feedRunning: Promise<void> | null = null;

    async function compiledNameRules(): Promise<CompiledNameRule<RuleRow>[]> {
        if (nameRules !== null && Date.now() - nameRules.at < NAME_RULES_TTL_MS) return nameRules.rules;
        const rows = await deps.repo.listNameRules();
        nameRules = { at: Date.now(), rules: compileNameRules(rows) };
        return nameRules.rules;
    }

    async function matching(subject: ModerationSubject): Promise<RuleRow | null> {
        if (subject.sha256 !== null) {
            const byHash = await deps.repo.findFingerprint(subject.sha256.toLowerCase());
            if (byHash !== null && coversExposure(byHash.exposure, subject.exposure)) return byHash;
        }
        for (const compiled of await compiledNameRules()) {
            if (coversExposure(compiled.rule.exposure, subject.exposure) && compiled.test(subject.name)) {
                return compiled.rule;
            }
        }
        return null;
    }

    async function record(subject: ModerationSubject, rule: RuleRow): Promise<void> {
        const at = now();
        const dedupeKey = dedupeKeyOf({
            feature: subject.origin.feature,
            workspaceId: subject.origin.workspaceId,
            ruleId: rule.id,
            sha256: subject.sha256,
            name: subject.name
        });
        await deps.repo.recordHit({
            feature: subject.origin.feature,
            rule_id: rule.id,
            kind: rule.kind,
            reason: rule.reason,
            label: rule.label,
            content: sealHit(deps.keys, dedupeKey, { name: subject.name, context: subject.origin.context }),
            sha256: subject.sha256,
            size: subject.size ?? null,
            workspace_id: subject.origin.workspaceId,
            user_id: subject.origin.userId,
            dedupe_key: dedupeKey,
            at
        });
        await deps.repo.bumpRule(rule.id, at);
    }

    const provider: ModerationProvider = {
        async check(subject) {
            const rule = await matching(subject);
            if (rule === null) return null;
            // La trace est ce qui rend la décision lisible : elle précède la réponse,
            // mais une base qui bafouille ici n'empêche pas d'arrêter le fichier.
            await record(subject, rule).catch((error: unknown) =>
                deps.logger.warn({ err: error, ruleId: rule.id }, 'moderation: détection non journalisée')
            );
            const hit: ModerationHit = {
                ruleId: rule.id,
                kind: rule.kind,
                reason: ruleReason(rule),
                label: rule.label
            };
            return hit;
        },

        async ban({ fingerprints, reason, label, by }) {
            const clean = [...new Set(fingerprints.map((hash) => hash.toLowerCase()))].filter((hash) =>
                /^[a-f0-9]{64}$/.test(hash)
            );
            if (clean.length === 0) return 0;
            return deps.repo.insertRules(
                clean.map((pattern) => ({
                    kind: 'fingerprint' as const,
                    pattern,
                    reason,
                    label,
                    exposure: 'everywhere' as const,
                    source: 'takedown' as const,
                    created_by: by
                }))
            );
        }
    };

    /** La liste externe, versée dans les règles ; une relecture en cours n'en lance pas une seconde. */
    function importFeed(): Promise<void> {
        if (env.MODERATION_FEED_URL.length === 0) return Promise.resolve();
        if (feedRunning === null) {
            feedRunning = pullFeed().finally(() => {
                feedRunning = null;
            });
        }
        return feedRunning;
    }

    async function pullFeed(): Promise<void> {
        const { repo } = deps;
        try {
            const text = await safeFetchText(env.MODERATION_FEED_URL, {
                maxBytes: FEED_MAX_BYTES,
                timeoutMs: FEED_TIMEOUT_MS,
                headers: env.MODERATION_FEED_AUTH_KEY.length > 0 ? { 'Auth-Key': env.MODERATION_FEED_AUTH_KEY } : {}
            });
            const { fingerprints } = parseFingerprints(text);
            const added = await repo.insertRules(
                fingerprints.map((pattern) => ({
                    kind: 'fingerprint' as const,
                    pattern,
                    reason: 'malware',
                    label: FEED_LABEL,
                    exposure: 'everywhere' as const,
                    source: 'feed' as const,
                    created_by: null
                }))
            );
            await repo.setMeta(META_FEED_AT, String(now()));
            await repo.setMeta(META_FEED_ERROR, '');
            if (added > 0) deps.logger.info({ added, read: fingerprints.length }, 'moderation: liste externe relue');
        } catch (error) {
            const message = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
            await repo.setMeta(META_FEED_ERROR, message).catch(() => undefined);
            // La liste qui ne répond pas est chez son éditeur ; une adresse refusée ou une clé fausse, chez l'instance.
            logFailure(deps.logger, isRemoteFailure(error), { err: message }, 'moderation: liste externe non relue');
        }
    }

    const ticker = deps.createTicker({
        intervalMs: TICK_MS,
        async tick() {
            const at = Date.now();
            if (at - lastFeed >= FEED_EVERY_MS) {
                lastFeed = at;
                await importFeed();
            }
            if (at - lastPurge >= PURGE_EVERY_MS) {
                lastPurge = at;
                await deps.repo.purgeHits(now() - HIT_RETENTION_SECONDS);
            }
        }
    });

    return {
        providers: { [MODERATION_PROVIDER]: provider },
        async start() {
            setRuntime({
                rulesChanged: () => {
                    nameRules = null;
                },
                feedStatus: async () => {
                    const [count, lastImport, lastError] = await Promise.all([
                        deps.repo.countBySource('feed'),
                        deps.repo.getMeta(META_FEED_AT),
                        deps.repo.getMeta(META_FEED_ERROR)
                    ]);
                    return {
                        configured: env.MODERATION_FEED_URL.length > 0,
                        count,
                        lastImport: lastImport === null || lastImport.length === 0 ? null : Number(lastImport),
                        lastError: lastError === null || lastError.length === 0 ? null : lastError
                    };
                },
                importFeed
            });
            await ticker.start();
        },
        async stop() {
            await ticker.stop();
            setRuntime(null);
        }
    };
}

function ruleReason(rule: RuleRow): ModerationHit['reason'] {
    switch (rule.reason) {
        case 'illegal':
        case 'copyright':
        case 'malware':
        case 'privacy':
        case 'minors':
            return rule.reason;
        default:
            return 'other';
    }
}
