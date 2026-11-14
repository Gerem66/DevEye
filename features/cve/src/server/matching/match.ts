import crypto from 'node:crypto';

import type { CveSeverity } from '../../contracts/domain';
import type { ExposureComponent, FindingKind } from '../../contracts/exposure';
import type { Dependency, Ecosystem } from '../inventory/lockfiles';
import { TOOLS } from '../inventory/tools';
import type { CveAffectingRow } from '../repo';
import { isAffected } from '../versions';
import { cvss3Score, severityOfScore } from './cvss';
import { eolProductOf, releaseFor, type EolIndex } from './eol';
import type { OsvHit, OsvOutcome } from './osv';
import { majorKey, majorsBehind, REGISTRY_SYSTEM, type PackageMeta } from './registry';

/**
 * Les composants d'un espace confrontés aux catalogues : OSV pour les paquets,
 * le NVD pour les produits. Ce qui sort est un brouillon par sujet (une faille
 * sur un paquet), avec les éléments qu'il touche ; c'est `reconcile` qui le
 * confronte aux constats déjà en base.
 */

export type FindingOrigin = 'osv' | 'nvd' | 'eol' | 'registry';

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
    /** Le catalogue des fins de vie, `null` tant qu'il n'a jamais été chargé. */
    eol(): Promise<EolIndex | null>;
    /**
     * Ce que les registres disent de ces paquets, par `system|name`. `reason`
     * dit pourquoi certains manquent (une panne, ou la lecture qui avance par
     * lots) : leurs constats d'avant restent alors tels quels.
     */
    registry(
        packages: readonly { system: string; name: string }[]
    ): Promise<{ metas: Map<string, PackageMeta | null>; reason: string | null }>;
}

/** Une fin de vie à moins de ça se signale déjà. */
const EOL_SOON_MS = 30 * 86_400_000;

function frenchDate(iso: string): string {
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    });
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
            const severity = note ? ('none' as const) : osvSeverity(vuln.severity, vuln.cvss);
            // La gravité d'un avis vient souvent d'un CVSS 4 que son vecteur 3 ne
            // reproduit pas : une note qui la contredit ne s'affiche pas.
            const computed = vuln.cvss ? cvss3Score(vuln.cvss) : null;
            const score = computed !== null && severityOfScore(computed) === severity ? computed : null;
            const draft = {
                kind,
                origin: 'osv' as const,
                subjectKey: subjectKey([kind, id, dep.ecosystem, dep.name]),
                advisoryId: id,
                severity,
                score,
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
                // Une faille qu'aucune version de la distribution ne corrige
                // encore n'est pas une action à prendre : les bases Debian et
                // Ubuntu en portent des centaines par machine.
                if (use.component.format === 'system-package' && vuln.fixed.length === 0) continue;
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
            if (c.kind !== 'product' || c.exact === false) continue;
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

    // Les fins de vie : chaque branche, de tout ce que l'espace fait tourner.
    const index = await catalogues.eol();
    if (index === null) unavailable.eol = 'Le catalogue des fins de vie n’a pas encore été chargé.';
    else {
        const now = Date.now();
        for (const asset of assets) {
            for (const c of asset.components) {
                const product = eolProductOf(c, index);
                const release = product ? releaseFor(product, c.version) : null;
                if (!product || !release) continue;
                const at = release.eolFrom ? Date.parse(`${release.eolFrom}T00:00:00Z`) : NaN;
                const reached = release.isEol || (Number.isFinite(at) && at <= now);
                if (!reached && !(Number.isFinite(at) && at - now <= EOL_SOON_MS)) continue;
                const when = release.eolFrom ? frenchDate(release.eolFrom) : null;
                const maintained = product.releases
                    .filter((r) => r.isMaintained && !r.isEol)
                    .slice(0, 2)
                    .map((r) => r.latest ?? r.name);
                touch(
                    {
                        kind: 'eol',
                        origin: 'eol',
                        subjectKey: subjectKey(['eol', product.name, release.name]),
                        advisoryId: null,
                        severity: reached ? 'high' : 'medium',
                        score: null,
                        content: {
                            title: `${product.label} ${release.name} : ${
                                reached
                                    ? when
                                        ? `fin de vie depuis le ${when}`
                                        : 'fin de vie'
                                    : `fin de vie le ${when}`
                            }`,
                            summary: reached
                                ? `${product.label} ${release.name} ne reçoit plus de correctifs : une faille découverte demain n’y sera pas corrigée.`
                                : `${product.label} ${release.name} ne recevra plus de correctifs après le ${when}.`,
                            subject: { kind: c.kind, ecosystem: c.ecosystem, name: product.label },
                            fixed: maintained,
                            reference: `https://endoflife.date/${product.name}`,
                            aliases: []
                        }
                    },
                    { assetId: asset.assetId, version: c.version, path: c.path, line: c.line }
                );
            }
        }
    }

    // Les dépendances directes chez leur registre : dépréciées, ou en retard.
    const wanted = new Map<string, { system: string; name: string }>();
    for (const asset of assets) {
        for (const c of asset.components) {
            const system = c.kind === 'package' && c.direct ? REGISTRY_SYSTEM[c.ecosystem] : undefined;
            if (system) wanted.set(`${system}|${c.name}`, { system, name: c.name });
        }
    }
    if (wanted.size > 0) {
        const answer = await catalogues.registry([...wanted.values()]);
        if (answer.reason !== null) unavailable.registry = answer.reason;
        for (const asset of assets) {
            for (const c of asset.components) {
                const system = c.kind === 'package' && c.direct ? REGISTRY_SYSTEM[c.ecosystem] : undefined;
                const meta = system ? answer.metas.get(`${system}|${c.name}`) : undefined;
                if (!system || !meta) continue;
                const reference = `https://deps.dev/${system.toLowerCase()}/${encodeURIComponent(c.name)}`;
                const subject = { kind: 'package' as const, ecosystem: c.ecosystem, name: c.name };
                const entry = { assetId: asset.assetId, version: c.version, path: c.path, line: c.line };
                const reason = meta.deprecated[c.version];
                if (reason !== undefined) {
                    touch(
                        {
                            kind: 'deprecated',
                            origin: 'registry',
                            subjectKey: subjectKey(['deprecated', c.ecosystem, c.name]),
                            advisoryId: null,
                            severity: 'none',
                            score: null,
                            content: {
                                title: `${c.name} : version dépréciée par son auteur`,
                                summary: reason || `${c.name} ${c.version} est marquée dépréciée dans son registre.`,
                                subject,
                                fixed: meta.latest ? [meta.latest] : [],
                                reference,
                                aliases: []
                            }
                        },
                        entry
                    );
                }
                const behind = meta.latest ? majorsBehind(c.version, meta.latest) : 0;
                if (meta.latest && behind > 0) {
                    touch(
                        {
                            kind: 'outdated',
                            origin: 'registry',
                            subjectKey: subjectKey(['outdated', c.ecosystem, c.name, majorKey(meta.latest)]),
                            advisoryId: null,
                            severity: 'none',
                            score: null,
                            content: {
                                title: `${c.name} : ${behind} version${behind > 1 ? 's' : ''} majeure${behind > 1 ? 's' : ''} de retard`,
                                summary: `La dernière version publiée de ${c.name} est la ${meta.latest}.`,
                                subject,
                                fixed: [meta.latest],
                                reference,
                                aliases: []
                            }
                        },
                        entry
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
