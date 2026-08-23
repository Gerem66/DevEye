import { sqlTableTargets } from './sql-tables';

/**
 * La part PURE de la désinstallation d'un module : les nettoyages de JSON et
 * la sentinelle du `uninstall.sql`, sans base ni fichier. C'est ce que les
 * tests exercent ; `uninstall-feature.ts` ne fait qu'orchestrer autour.
 */

/**
 * Le `uninstall.sql` d'un module ne peut détruire QUE ses tables `ft_<slug>_*`.
 *
 * Volontairement SANS l'allowlist `deveye-feature.json.tables` : les tables
 * historiques d'une native rapatriée (weather_locations, osint_lookups…) sont
 * des données de l'application — un module qui les détruirait à sa
 * désinstallation emporterait autre chose que lui. Rend les tables hors
 * contrat, vide si tout est en règle.
 */
export function forbiddenUninstallTargets(featureId: string, sql: string): string[] {
    const prefix = `ft_${featureId.replace(/^x-/, '')}_`;
    return [...new Set(sqlTableTargets(sql).filter((t) => !t.startsWith(prefix)))];
}

/** Un grant de rôle, tel que `workspace_roles.features` les porte. */
interface RoleGrant {
    feature?: string;
    [key: string]: unknown;
}

/**
 * Retire du JSON `features` d'un rôle les grants de la feature désinstallée
 * (droit, extras et canaux d'un coup : le grant entier n'a plus d'objet).
 * Rend `null` quand rien ne change, pour n'écrire que les rôles touchés.
 */
export function scrubRoleGrants(featuresJson: string, featureId: string): string | null {
    let grants: RoleGrant[];
    try {
        grants = JSON.parse(featuresJson) as RoleGrant[];
    } catch {
        return null;
    }
    if (!Array.isArray(grants)) return null;
    const kept = grants.filter((g) => g?.feature !== featureId);
    return kept.length === grants.length ? null : JSON.stringify(kept);
}

/** Une disposition d'accueil, réduite à ce que le nettoyage touche. */
interface LayoutShape {
    topbar?: unknown[];
    sections?: { items?: unknown[]; [key: string]: unknown }[];
    [key: string]: unknown;
}

/**
 * Retire la feature d'une disposition d'accueil : sa tuile dans chaque
 * section, son id dans chaque dossier, son mini-widget de topbar. Les autres
 * tuiles (raccourcis, appareils, dossiers devenus vides) restent telles
 * quelles. Rend `null` quand rien ne change.
 */
export function scrubHomeLayout(layoutJson: string, featureId: string): string | null {
    let layout: LayoutShape;
    try {
        layout = JSON.parse(layoutJson) as LayoutShape;
    } catch {
        return null;
    }
    if (typeof layout !== 'object' || layout === null) return null;
    let changed = false;

    if (Array.isArray(layout.topbar)) {
        const kept = layout.topbar.filter((id) => id !== featureId);
        if (kept.length !== layout.topbar.length) {
            layout.topbar = kept;
            changed = true;
        }
    }

    for (const section of layout.sections ?? []) {
        if (!Array.isArray(section?.items)) continue;
        const kept = section.items
            .filter((tile) => tile !== featureId)
            .map((tile) => {
                // Un dossier porte ses ids de features dans `items`.
                if (typeof tile === 'object' && tile !== null && (tile as { kind?: string }).kind === 'folder') {
                    const folder = tile as { items?: unknown[] };
                    if (Array.isArray(folder.items) && folder.items.includes(featureId)) {
                        changed = true;
                        return { ...folder, items: folder.items.filter((id) => id !== featureId) };
                    }
                }
                return tile;
            });
        if (kept.length !== section.items.length) changed = true;
        section.items = kept;
    }

    return changed ? JSON.stringify(layout) : null;
}
