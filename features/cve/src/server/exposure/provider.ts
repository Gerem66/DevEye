import type { CveExposureProvider, CveItemFinding } from '@deveye/types/sdk';
import type { FeatureServiceDeps } from '@deveye/types/sdk/server';

import type { FindingContent } from '../matching/match';
import type { CveRepo } from '../repo';
import { openJson } from './shared';

/** Ce que la veille sait d'un élément d'une autre feature : ce qu'Audit montre d'un dépôt. */
export function exposureProvider(deps: FeatureServiceDeps<CveRepo>): CveExposureProvider {
    return {
        async ofItem(workspaceId, item) {
            const asset = (await deps.repo.listAssets(workspaceId)).find(
                (a) => a.source === item.feature && a.ref === String(item.itemId)
            );
            if (!asset) return null;
            const cipher = deps.cipherFor(workspaceId);
            const linked = new Set(
                (await deps.repo.linksOf(workspaceId)).filter((l) => l.asset_id === asset.id).map((l) => l.finding_id)
            );
            const findings: CveItemFinding[] = [];
            for (const row of await deps.repo.listFindings(workspaceId)) {
                if (row.state === 'resolved' || !linked.has(row.id)) continue;
                const content = await openJson<FindingContent | null>(cipher, row.content_enc, null);
                const here = content?.affected.find((a) => a.assetId === asset.id);
                if (!content || !here) continue;
                findings.push({
                    id: row.id,
                    kind: row.kind,
                    state: row.state,
                    advisoryId: row.advisory_id,
                    severity: row.severity,
                    score: row.score === null ? null : Number(row.score),
                    title: content.title,
                    summary: content.summary,
                    component: { ...content.subject, version: here.version },
                    path: here.path,
                    line: here.line,
                    fixed: content.fixed,
                    reference: content.reference
                });
            }
            return {
                status: asset.excluded === 1 ? 'excluded' : asset.status,
                scannedAt: asset.scanned_at === null ? null : Number(asset.scanned_at),
                revision: asset.revision,
                error: asset.error_enc === null ? null : await cipher.tryDecrypt(asset.error_enc),
                findings
            };
        }
    };
}
