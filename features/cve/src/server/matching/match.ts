import crypto from 'node:crypto';

import type { CveSeverity } from '../../contracts/domain';
import type { ExposureComponent, FindingKind } from '../../contracts/exposure';
import type { Dependency, Ecosystem } from '../inventory/lockfiles';
import { TOOLS } from '../inventory/tools';
import type { CveAffectingRow } from '../repo';
import { isAffected } from '../versions';
import { cvss3Score, severityOfScore } from './cvss';
import type { OsvHit, OsvOutcome } from './osv';

/**
 * Les composants d'un espace confrontés aux catalogues : OSV pour les paquets,
 * le NVD pour les produits. Ce qui sort est un brouillon par sujet (une faille
 * sur un paquet), avec les éléments qu'il touche ; c'est `reconcile` qui le
 * confronte aux constats déjà en base.
 */

export type FindingOrigin = 'osv' | 'nvd';

/** Ce qu'un élément a de touché par un constat. */
export interface AffectedEntry {
    assetId: number;
    version: string;
    path: string | null;
    line: number | null;
}

/** Ce que `content_enc` scelle d'un constat. */
export interface FindingContent {
    title: string;
    summary: string;
    subject: { kind: 'package' | 'product'; ecosystem: string; name: string };
    fixed: string[];
    reference: string | null;
    aliases: string[];
    affected: AffectedEntry[];
}

export interface FindingDraft {
    kind: FindingKind;
    origin: FindingOrigin;
    subjectKey: string;
    advisoryId: string | null;
    severity: CveSeverity;
    score: number | null;
    content: FindingContent;
}

export interface AssetComponents {
    assetId: number;
    components: readonly ExposureComponent[];
}

export interface MatchCatalogues {
    osv(dependencies: readonly Dependency[]): Promise<OsvOutcome>;
    /** Toutes les lignes qui rattachent une CVE à ce produit. */
    nvd(vendor: string, product: string): Promise<readonly CveAffectingRow[]>;
    /** Pourquoi le NVD ne peut pas encore répondre de ces produits, ou `null`. */
    nvdStale(products: readonly { vendor: string; product: string }[]): Promise<string | null>;
}

export interface MatchResult {
    drafts: FindingDraft[];
    /** Par catalogue, la raison qui l'a empêché de répondre : ses constats d'avant restent alors tels quels. */
    unavailable: Partial<Record<FindingOrigin, string>>;
}

export function subjectKey(parts: readonly string[]): string {
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Ce qu'OSV nomme, ramené aux gravités du catalogue ; à défaut de mot, la note du vecteur CVSS. */
function osvSeverity(raw: string | null, cvss: string | null): CveSeverity {
    switch ((raw ?? '').toUpperCase()) {
        case 'CRITICAL':
            return 'critical';
        case 'HIGH':
            return 'high';
        case 'MODERATE':
        case 'MEDIUM':
            return 'medium';
        case 'LOW':
            return 'low';
        default: {
            const score = cvss ? cvss3Score(cvss) : null;
            // Un avis sans gravité ni vecteur lisible existe quand même : le
            // classer « moyen » le laisse visible sans lui donner le pas sur ce
            // qui est vraiment grave.
            return score === null ? 'medium' : severityOfScore(score);
        }
    }
}

/** L'identifiant public à montrer : la CVE quand il y en a une, l'avis OSV sinon. */
function publicId(hit: OsvHit): string {
    return hit.vuln.aliases.find((a) => a.startsWith('CVE-')) ?? hit.vuln.id;
}

/** Ce que RustSec dit d'un paquet sans faille connue, mais qu'il faut savoir. */
const INFORMATIONAL: Record<string, string> = {
    unmaintained: 'paquet non maintenu',
    unsound: 'paquet au code non sûr',
    notice: 'avis de son registre'
};

const depKey = (d: { ecosystem: string; name: string; version: string }): string =>
    `${d.ecosystem}|${d.name}|${d.version}`;

export async function matchComponents(
    assets: readonly AssetComponents[],
    catalogues: MatchCatalogues
): Promise<MatchResult> {
    const drafts = new Map<string, FindingDraft>();
    const unavailable: MatchResult['unavailable'] = {};

    const touch = (
        draft: Omit<FindingDraft, 'content'> & { content: Omit<FindingContent, 'affected'> },
        entry: AffectedEntry
    ): void => {
        const key = `${draft.kind}|${draft.subjectKey}`;
        const existing = drafts.get(key) ?? { ...draft, content: { ...draft.content, affected: [] } };
        if (!existing.content.affected.some((a) => a.assetId === entry.assetId)) existing.content.affected.push(entry);
        drafts.set(key, existing);
    };

    // Les paquets : une requête OSV pour tous les éléments de l'espace.
    const usesByDep = new Map<string, { assetId: number; component: ExposureComponent }[]>();
    const dependencies: Dependency[] = [];
    for (const asset of assets) {
        for (const c of asset.components) {
            if (c.kind !== 'package') continue;
            const key = depKey(c);
            if (!usesByDep.has(key)) {
                usesByDep.set(key, []);
                dependencies.push({ ecosystem: c.ecosystem as Ecosystem, name: c.name, version: c.version });
            }
            usesByDep.get(key)!.push({ assetId: asset.assetId, component: c });
        }
    }
    const osv = await catalogues.osv(dependencies);
    if (osv.status === 'unavailable') unavailable.osv = osv.reason;
    else {
        for (const hit of osv.hits) {
            const { dependency: dep, vuln } = hit;
            const id = publicId(hit);
            const note = vuln.informational ? (INFORMATIONAL[vuln.informational] ?? vuln.informational) : null;
            const kind: FindingKind = note ? 'deprecated' : 'vuln';
            const draft = {
                kind,
                origin: 'osv' as const,
                subjectKey: subjectKey([kind, id, dep.ecosystem, dep.name]),
                advisoryId: id,
                severity: note ? ('none' as const) : osvSeverity(vuln.severity, vuln.cvss),
                score: vuln.cvss ? cvss3Score(vuln.cvss) : null,
                content: {
                    title: note ? `${dep.name} : ${note}` : `${dep.name} : ${firstSentence(vuln.summary)}`,
                    summary: vuln.summary,
                    subject: { kind: 'package' as const, ecosystem: dep.ecosystem, name: dep.name },
                    fixed: vuln.fixed,
                    reference: `https://osv.dev/vulnerability/${vuln.id}`,
                    aliases: [vuln.id, ...vuln.aliases].filter((a, i, all) => a !== id && all.indexOf(a) === i)
                }
            };
            for (const use of usesByDep.get(depKey(dep)) ?? []) {
                touch(draft, {
                    assetId: use.assetId,
                    version: dep.version,
                    path: use.component.path,
                    line: use.component.line
                });
            }
        }
    }

    // Les produits : le catalogue local du NVD, sans appel au dehors.
    const products = new Map<string, { vendor: string; product: string }>();
    for (const asset of assets) {
        for (const c of asset.components) {
            for (const p of c.kind === 'product' ? (TOOLS[c.ecosystem]?.products ?? []) : []) {
                products.set(`${p.vendor}:${p.product}`, p);
            }
        }
    }
    if (products.size > 0) {
        const stale = await catalogues.nvdStale([...products.values()]);
        if (stale !== null) unavailable.nvd = stale;
    }
    const rowsOf = new Map<string, readonly CveAffectingRow[]>();
    for (const asset of assets) {
        for (const c of asset.components) {
            if (c.kind !== 'product') continue;
            const tool = TOOLS[c.ecosystem];
            if (!tool) continue;
            const seen = new Set<string>();
            for (const p of tool.products) {
                const key = `${p.vendor}:${p.product}`;
                if (!rowsOf.has(key)) rowsOf.set(key, await catalogues.nvd(p.vendor, p.product));
                for (const row of rowsOf.get(key) ?? []) {
                    if (seen.has(row.cve_id) || !isAffected(c.version, row)) continue;
                    seen.add(row.cve_id);
                    touch(
                        {
                            kind: 'vuln',
                            origin: 'nvd',
                            subjectKey: subjectKey(['vuln', row.cve_id, 'tool', c.ecosystem]),
                            advisoryId: row.cve_id,
                            severity: row.severity,
                            score: row.score === null ? null : Number(row.score),
                            content: {
                                title: `${tool.label} : ${firstSentence(row.summary)}`,
                                summary: row.summary,
                                subject: { kind: 'product', ecosystem: c.ecosystem, name: tool.label },
                                fixed: row.end_excl ? [row.end_excl] : [],
                                reference: `https://nvd.nist.gov/vuln/detail/${row.cve_id}`,
                                aliases: []
                            }
                        },
                        { assetId: asset.assetId, version: c.version, path: c.path, line: c.line }
                    );
                }
            }
        }
    }

    return { drafts: [...drafts.values()], unavailable };
}

/** La première phrase d'un résumé du NVD, qui en fait souvent dix : de quoi titrer une ligne. */
export function firstSentence(text: string, max = 140): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    const end = flat.search(/\.\s/);
    const sentence = end > 0 ? flat.slice(0, end) : flat.replace(/\.$/, '');
    return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}
