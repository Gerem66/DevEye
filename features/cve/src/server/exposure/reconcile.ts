import type { FindingKind, FindingState } from '../../contracts/exposure';
import type { FindingDraft, FindingOrigin } from '../matching/match';

/**
 * Les constats d'un espace confrontés à ce qu'une évaluation vient de
 * trouver. Fonction pure : c'est ici que se décident l'ouverture, la
 * réouverture et la résolution, donc les alertes.
 */

/** Un constat tel que la base le tient, avec les éléments qu'il touche et ceux qu'une décision a vus. */
export interface ExistingFinding {
    id: number;
    kind: FindingKind;
    subjectKey: string;
    origin: string;
    state: FindingState;
    severity: string;
    score: number | null;
    /** Élément touché, et vu ou non par la décision d'ignorer. */
    links: ReadonlyMap<number, boolean>;
}

export type FindingOp =
    | { type: 'insert'; draft: FindingDraft }
    | {
          type: 'update';
          id: number;
          draft: FindingDraft;
          state: 'open' | 'ignored';
          reopened: boolean;
          /** Les éléments que la décision d'ignorer couvre encore. */
          covered: number[];
          /** Ce que les écrans montrent a changé : état, éléments touchés ou gravité. */
          significant: boolean;
      }
    | { type: 'resolve'; id: number };

const keyOf = (kind: string, subjectKey: string): string => `${kind}|${subjectKey}`;

export function reconcile(
    existing: readonly ExistingFinding[],
    drafts: readonly FindingDraft[],
    unavailable: Partial<Record<FindingOrigin, string>>
): FindingOp[] {
    const ops: FindingOp[] = [];
    const byKey = new Map(existing.map((f) => [keyOf(f.kind, f.subjectKey), f]));
    const seen = new Set<string>();

    for (const draft of drafts) {
        const key = keyOf(draft.kind, draft.subjectKey);
        seen.add(key);
        const found = byKey.get(key);
        if (!found) {
            ops.push({ type: 'insert', draft });
            continue;
        }
        const assets = draft.content.affected.map((a) => a.assetId);
        const sameAssets = assets.length === found.links.size && assets.every((id) => found.links.has(id));
        let state: 'open' | 'ignored' = 'open';
        let reopened = false;
        let covered: number[] = [];
        if (found.state === 'resolved') reopened = true;
        else if (found.state === 'ignored') {
            // La décision valait pour ce qui était touché alors : un élément
            // touché depuis la rouvre, et elle repart de zéro.
            const fresh = assets.filter((id) => found.links.get(id) !== true);
            if (fresh.length > 0) reopened = true;
            else {
                state = 'ignored';
                covered = assets;
            }
        }
        const significant =
            reopened ||
            !sameAssets ||
            found.severity !== draft.severity ||
            (found.score === null ? null : Number(found.score)) !== draft.score;
        ops.push({ type: 'update', id: found.id, draft, state, reopened, covered, significant });
    }

    for (const f of existing) {
        if (f.state === 'resolved' || seen.has(keyOf(f.kind, f.subjectKey))) continue;
        // Un catalogue qui n'a pas répondu ne dit pas que la faille a disparu.
        if (unavailable[f.origin as FindingOrigin] !== undefined) continue;
        ops.push({ type: 'resolve', id: f.id });
    }
    return ops;
}
