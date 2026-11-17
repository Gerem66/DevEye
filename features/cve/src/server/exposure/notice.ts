// Helpers Discord partagés par tous les émetteurs de l'app : importés, pas recopiés.
import { COLOR_DANGER, COLOR_INFO, COLOR_WARNING, trim } from '@/Services/notices/shared';
import type { SdkAlert } from '@deveye/types/sdk/server';

import type { CveSeverity } from '../../contracts/domain';
import type { AlertThreshold, ExposurePrefs, FindingKind } from '../../contracts/exposure';
import type { FindingContent } from '../matching/match';

/**
 * Les avis de la veille. Un avis par constat, jamais un par élément touché :
 * la cause est la faille, il compte et nomme ce qu'elle touche. Le corps en
 * texte se suffit à lui-même ; l'embed n'en est que la mise en page Discord.
 */

/** Un constat qui vient de s'ouvrir, ou de revenir. */
export interface AlertedFinding {
    kind: FindingKind;
    advisoryId: string | null;
    severity: CveSeverity;
    score: number | null;
    content: FindingContent;
    reopened: boolean;
}

const SEVERITY_WORD: Record<CveSeverity, string> = {
    critical: 'critique',
    high: 'élevée',
    medium: 'moyenne',
    low: 'faible',
    none: 'non qualifiée'
};

const RANK: Record<CveSeverity, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const THRESHOLD_RANK: Record<AlertThreshold, number> = { all: 0, medium: 2, high: 3, critical: 4 };

/** Ce constat doit-il partir, d'après ce que l'espace a réglé ? */
export function isAlertable(f: Pick<AlertedFinding, 'kind' | 'severity'>, prefs: ExposurePrefs): boolean {
    if (!prefs.alerts[f.kind]) return false;
    return f.kind !== 'vuln' || RANK[f.severity] >= THRESHOLD_RANK[prefs.threshold];
}

/** Les premiers éléments touchés, nommés, puis le compte du reste. */
function touched(labels: readonly string[], max = 3): string {
    const shown = labels.slice(0, max).join(', ');
    return labels.length > max ? `${shown} et ${labels.length - max} autres` : shown;
}

function severityPart(f: AlertedFinding): string {
    if (f.kind !== 'vuln') return '';
    const score = f.score === null ? '' : ` ${f.score.toFixed(1)}`;
    return ` (gravité ${SEVERITY_WORD[f.severity]}${score})`;
}

/** Ce qu'un constat est, en tête de son avis. */
const KIND_LEAD: Record<FindingKind, { icon: string; word: string }> = {
    vuln: { icon: '🐞', word: 'Faille' },
    eol: { icon: '⏳', word: 'Fin de vie' },
    deprecated: { icon: '📦', word: 'Paquet signalé par son registre' },
    outdated: { icon: '🕰️', word: 'Dépendance en retard' }
};

function colorOf(f: AlertedFinding): number {
    if (f.kind === 'eol') return f.severity === 'high' ? COLOR_DANGER : COLOR_WARNING;
    if (f.kind !== 'vuln') return COLOR_INFO;
    return RANK[f.severity] >= RANK.high ? COLOR_DANGER : COLOR_WARNING;
}

export function findingAlert(f: AlertedFinding, labelOf: (assetId: number) => string): SdkAlert {
    const labels = f.content.affected.map((a) => labelOf(a.assetId));
    const { icon, word: what } = KIND_LEAD[f.kind];
    const where = labels.length > 1 ? `${labels.length} éléments` : labels[0];
    const id = f.advisoryId ?? f.content.subject.name;
    const subject =
        f.kind === 'vuln' ? `${icon} ${id}${severityPart(f)} touche ${where}` : `${icon} ${f.content.title} (${where})`;
    const versions = [...new Set(f.content.affected.map((a) => a.version))].join(', ');
    const lines = [
        `${what}${f.reopened ? ' de retour' : ''} : ${f.content.title}`,
        `Touche : ${touched(labels)}`,
        `Composant : ${f.content.subject.name} ${versions}`,
        f.kind === 'vuln'
            ? `Corrigé en : ${f.content.fixed.length > 0 ? f.content.fixed.join(', ') : 'aucune version corrigée publiée'}`
            : f.kind === 'eol'
              ? `Branches maintenues : ${f.content.fixed.length > 0 ? f.content.fixed.join(', ') : 'aucune'}`
              : `Dernière version : ${f.content.fixed[0] ?? 'inconnue'}`,
        ...(f.content.reference ? [`Avis : ${f.content.reference}`] : [])
    ];
    return {
        subject,
        body: lines.join('\n'),
        payload: {
            event: f.reopened ? 'finding.reopened' : 'finding.opened',
            kind: f.kind,
            advisoryId: f.advisoryId,
            severity: f.severity,
            score: f.score,
            component: f.content.subject,
            versions: [...new Set(f.content.affected.map((a) => a.version))],
            fixed: f.content.fixed,
            affected: labels,
            reference: f.content.reference
        },
        embeds: [
            {
                title: trim(f.kind === 'vuln' ? `${icon} ${id}${severityPart(f)}` : `${icon} ${f.content.title}`),
                description: trim(f.content.title),
                url: f.content.reference ?? undefined,
                color: colorOf(f),
                fields: [
                    { name: '📦 Composant', value: trim(`${f.content.subject.name} ${versions}`), inline: true },
                    {
                        name: '🩹 Corrigé en',
                        value: trim(f.content.fixed.length > 0 ? f.content.fixed.join(', ') : 'rien de publié'),
                        inline: true
                    },
                    { name: `🎯 Touche (${labels.length})`, value: trim(touched(labels, 8)), inline: false }
                ],
                footer: { text: 'DevEye · veille CVE' }
            }
        ]
    };
}

/** Ce qu'un élément lu pour la première fois a donné : de quoi le récapituler en une ligne. */
export interface FirstScan {
    label: string;
    critical: number;
    vulns: number;
    others: number;
}

function scanLine(s: FirstScan): string {
    const parts: string[] = [];
    if (s.vulns > 0) {
        const critical = s.critical > 0 ? ` dont ${s.critical} critique${s.critical > 1 ? 's' : ''}` : '';
        parts.push(`${s.vulns} faille${s.vulns > 1 ? 's' : ''}${critical}`);
    }
    if (s.others > 0) parts.push(`${s.others} autre${s.others > 1 ? 's' : ''} constat${s.others > 1 ? 's' : ''}`);
    return `${s.label} : ${parts.join(', ')}`;
}

/**
 * Un seul avis pour ce qu'un premier inventaire a trouvé, quel que soit le
 * nombre d'éléments neufs : ajouter vingt dépôts ne doit pas noyer le canal.
 */
export function firstScanAlert(scans: readonly FirstScan[]): SdkAlert {
    const total = scans.reduce((n, s) => n + s.vulns + s.others, 0);
    const critical = scans.some((s) => s.critical > 0);
    const subject = `🐞 Premier inventaire : ${total} constat${total > 1 ? 's' : ''} dans ${
        scans.length > 1 ? `${scans.length} éléments` : scans[0].label
    }`;
    const lines = scans.slice(0, 20).map(scanLine);
    if (scans.length > 20) lines.push(`et ${scans.length - 20} autres éléments`);
    return {
        subject,
        body: ['La veille vient de lire pour la première fois :', ...lines].join('\n'),
        payload: {
            event: 'inventory.first',
            elements: scans.map((s) => ({ label: s.label, vulns: s.vulns, critical: s.critical, others: s.others }))
        },
        embeds: [
            {
                title: trim(subject),
                description: trim(lines.join('\n')),
                color: critical ? COLOR_DANGER : COLOR_WARNING,
                footer: { text: 'DevEye · veille CVE' }
            }
        ]
    };
}
