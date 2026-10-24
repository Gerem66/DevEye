import { createHash } from 'node:crypto';

import type { SdkFeatureContext, SdkServerKeys } from '@deveye/types/sdk/server';
import { z } from 'zod';

import { moderationReasonSchema, type Hit, type Rule } from '../contracts/domain';
import type { HitRow, ModerationRepo, RuleRow } from './repo';

export type Ctx = SdkFeatureContext<ModerationRepo>;

export const now = (): number => Math.floor(Date.now() / 1000);

/** Ce qu'une détection garde sous scellé : le nom du fichier et l'élément qui le portait. */
export const hitContentSchema = z.object({ name: z.string(), context: z.string() });
export type HitContent = z.infer<typeof hitContentSchema>;

/** Le contexte lie le blob à sa ligne : recopié ailleurs, il ne s'ouvre pas. */
export const hitContext = (dedupeKey: string) => `ft_moderation_hits:content:${dedupeKey}`;

export function sealHit(keys: SdkServerKeys, dedupeKey: string, content: HitContent): string {
    return keys.sealBytes(Buffer.from(JSON.stringify(content), 'utf8'), hitContext(dedupeKey));
}

export function openHit(keys: SdkServerKeys, row: Pick<HitRow, 'dedupe_key' | 'content'>): HitContent | null {
    const bytes = keys.openBytes(row.content, hitContext(row.dedupe_key));
    if (bytes === null) return null;
    try {
        const parsed = hitContentSchema.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** La même règle sur le même fichier au même endroit : une ligne, quel que soit le nombre d'essais. */
export function dedupeKeyOf(input: {
    feature: string;
    workspaceId: number | null;
    ruleId: number;
    sha256: string | null;
    name: string;
}): string {
    return createHash('sha256')
        .update(
            [
                input.feature,
                input.workspaceId === null ? '' : String(input.workspaceId),
                String(input.ruleId),
                input.sha256 ?? '',
                input.name.normalize('NFC').toLowerCase()
            ].join('\n')
        )
        .digest('hex');
}

function reasonOf(raw: string) {
    const parsed = moderationReasonSchema.safeParse(raw);
    return parsed.success ? parsed.data : 'other';
}

export function ruleView(row: RuleRow): Rule {
    return {
        id: row.id,
        kind: row.kind,
        pattern: row.pattern,
        reason: reasonOf(row.reason),
        label: row.label,
        exposure: row.exposure,
        source: row.source,
        hits: Number(row.hits),
        lastHit: row.last_hit === null ? null : Number(row.last_hit),
        created: Number(row.created)
    };
}

/** `origin` : l'espace et le compte d'origine, que seul un administrateur lit. */
export function hitView(keys: SdkServerKeys, row: HitRow, origin: boolean): Hit {
    const content = openHit(keys, row);
    return {
        id: row.id,
        feature: row.feature,
        ruleId: row.rule_id,
        kind: row.kind,
        reason: reasonOf(row.reason),
        label: row.label,
        name: content?.name ?? 'Nom illisible : les clés du serveur ont changé.',
        context: content?.context ?? '',
        sha256: row.sha256,
        size: row.size === null ? null : Number(row.size),
        workspaceId: origin ? row.workspace_id : null,
        userId: origin ? row.user_id : null,
        count: Number(row.count),
        firstSeen: Number(row.first_seen),
        lastSeen: Number(row.last_seen)
    };
}
