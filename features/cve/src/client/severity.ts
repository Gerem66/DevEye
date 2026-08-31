import type { CveSeverity, CveSeverityFilter } from '../contracts/domain';

/** Le vocabulaire de la gravité, dit une fois pour les listes, le détail et la carte. */
export const SEVERITY_LABEL: Record<CveSeverity, string> = {
    critical: 'Critique',
    high: 'Élevée',
    medium: 'Moyenne',
    low: 'Faible',
    none: 'Non qualifiée'
};

/** Les filtres proposés, du plus grave au plus faible. « Non qualifiée » n'en est pas un : elle noierait le fil. */
export const SEVERITY_FILTERS: readonly { value: CveSeverityFilter; label: string }[] = [
    { value: 'all', label: 'Toutes' },
    { value: 'critical', label: 'Critique' },
    { value: 'high', label: 'Élevée' },
    { value: 'medium', label: 'Moyenne' },
    { value: 'low', label: 'Faible' }
];

/** Le ton de la pastille d'état, aligné sur celui des constats de Sentinelle. */
export function severityTone(severity: CveSeverity): 'danger' | 'warning' | 'accent' | 'neutral' {
    if (severity === 'critical') return 'danger';
    if (severity === 'high') return 'warning';
    if (severity === 'medium') return 'accent';
    return 'neutral';
}

/** L'âge d'une publication, en français et court : « auj. », « 3 j », « 2 sem ». */
export function ago(epochSeconds: number): string {
    if (epochSeconds <= 0) return '—';
    const days = Math.floor((Date.now() / 1000 - epochSeconds) / 86_400);
    if (days <= 0) return 'auj.';
    if (days === 1) return 'hier';
    if (days < 7) return `${days} j`;
    if (days < 31) return `${Math.floor(days / 7)} sem`;
    if (days < 365) return `${Math.floor(days / 30)} mois`;
    const years = Math.floor(days / 365);
    return `${years} an${years > 1 ? 's' : ''}`;
}

/** La date complète, pour l'infobulle et le détail. */
export function fullDate(epochSeconds: number): string {
    if (epochSeconds <= 0) return 'date inconnue';
    return new Date(epochSeconds * 1000).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

/**
 * Ce que le NVD dit d'une référence, en français. Vocabulaire fermé de leur
 * côté ; une étiquette inconnue s'affiche telle quelle plutôt que de disparaître.
 */
const REFERENCE_TAGS: Record<string, string> = {
    'Broken Link': 'Lien mort',
    Exploit: 'Exploit',
    'Issue Tracking': 'Suivi',
    'Mailing List': 'Liste de diffusion',
    Mitigation: 'Contournement',
    'Not Applicable': 'Hors sujet',
    Patch: 'Correctif',
    'Permissions Required': 'Accès requis',
    'Press/Media Coverage': 'Presse',
    Product: 'Produit',
    'Release Notes': 'Notes de version',
    'Technical Description': 'Analyse technique',
    'Third Party Advisory': 'Avis tiers',
    'US Government Resource': 'Source gouvernementale',
    'Vendor Advisory': 'Avis de l\u2019éditeur',
    'VDB Entry': 'Base de vulnérabilités'
};

export function referenceTag(tag: string): string {
    return REFERENCE_TAGS[tag] ?? tag;
}

/**
 * Le nom d'hôte d'une référence, sans le `www.` : c'est ce qui dit où le lien
 * mène. L'URL est validée par le contrat, mais la lecture reste gardée.
 */
export function referenceHost(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}
