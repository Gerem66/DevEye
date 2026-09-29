import type { ComponentState } from './state';
import { DAY, dayOf, type ComponentRow, type DailyRow, type IncidentRow } from './store';

/**
 * Ce que la page montre, calculé des compteurs et des incidents. Pur : le
 * rendu HTML n'a plus qu'à l'écrire.
 */

export const PAGE_DAYS = 90;
export const HISTORY_DAYS = 30;
export const HISTORY_MAX = 30;

export type BarTone = 'up' | 'degraded' | 'maintenance' | 'down' | 'empty';
export type ShownState = ComponentState | 'pending';
export type BannerTone = 'up' | 'degraded' | 'maintenance' | 'down' | 'pending';

export interface StatusBar {
    day: number;
    tone: BarTone;
    ratio: number | null;
    downSeconds: number;
    maintenanceSeconds: number;
}

export interface ComponentView {
    id: string;
    label: string;
    state: ShownState;
    since: number | null;
    reason: string | null;
    inherited: boolean;
    bars: StatusBar[];
    /** Opérationnel ou perturbé, sur toutes les mesures : la maintenance compte contre. */
    ratio: number | null;
}

export interface IncidentView {
    label: string;
    state: IncidentRow['state'];
    reason: string | null;
    message: string | null;
    startedAt: number;
    endedAt: number | null;
}

export interface PickerEntry {
    id: string;
    label: string;
    state: ShownState;
}

export interface StatusView {
    generatedAt: number;
    /** `null` sur la vue d'ensemble. */
    feature: { id: string; label: string } | null;
    banner: { tone: BannerTone; title: string; detail: string | null; message: string | null };
    components: ComponentView[];
    ongoing: IncidentView[];
    history: IncidentView[];
    picker: PickerEntry[];
}

export interface ViewInput {
    now: number;
    intervalSeconds: number;
    components: readonly ComponentRow[];
    daily(id: string, fromDay: number): DailyRow[];
    incidents(ids: readonly string[], since: number): IncidentRow[];
}

const shown = (c: ComponentRow): ShownState => c.state ?? 'pending';

function toneOf(row: DailyRow | undefined): BarTone {
    if (!row || row.checks === 0) return 'empty';
    if (row.down > 0) return 'down';
    if (row.maintenance > 0) return 'maintenance';
    if (row.degraded > 0) return 'degraded';
    return 'up';
}

export function barsOf(rows: readonly DailyRow[], now: number, intervalSeconds: number): StatusBar[] {
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const today = dayOf(now);
    const bars: StatusBar[] = [];
    for (let i = PAGE_DAYS - 1; i >= 0; i--) {
        const day = today - i * DAY;
        const row = byDay.get(day);
        bars.push({
            day,
            tone: toneOf(row),
            ratio: row && row.checks > 0 ? (row.up + row.degraded) / row.checks : null,
            downSeconds: (row?.down ?? 0) * intervalSeconds,
            maintenanceSeconds: (row?.maintenance ?? 0) * intervalSeconds
        });
    }
    return bars;
}

export function ratioOf(rows: readonly DailyRow[]): number | null {
    const checks = rows.reduce((n, r) => n + r.checks, 0);
    if (checks === 0) return null;
    return rows.reduce((n, r) => n + r.up + r.degraded, 0) / checks;
}

function componentView(c: ComponentRow, input: ViewInput): ComponentView {
    const rows = input.daily(c.id, dayOf(input.now) - (PAGE_DAYS - 1) * DAY);
    return {
        id: c.id,
        label: c.label,
        state: shown(c),
        since: c.since,
        reason: c.reason,
        inherited: c.inherited,
        bars: barsOf(rows, input.now, input.intervalSeconds),
        ratio: ratioOf(rows)
    };
}

function incidentsOf(ids: readonly string[], labels: ReadonlyMap<string, string>, input: ViewInput) {
    const rows = input.incidents(ids, input.now - HISTORY_DAYS * DAY);
    const view = (r: IncidentRow): IncidentView => ({
        label: labels.get(r.component) ?? r.component,
        state: r.state,
        reason: r.reason,
        message: r.message,
        startedAt: r.startedAt,
        endedAt: r.endedAt
    });
    return {
        ongoing: rows.filter((r) => r.endedAt === null).map(view),
        history: rows.slice(0, HISTORY_MAX).map(view)
    };
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n > 1 ? 's' : ''}`;
}

function overviewBanner(app: ComponentRow | undefined, others: readonly ComponentRow[]): StatusView['banner'] {
    if (!app || app.state === null) {
        return { tone: 'pending', title: 'Vérification en cours', detail: null, message: null };
    }
    if (app.state === 'down') {
        return { tone: 'down', title: 'DevEye est hors service', detail: app.reason, message: null };
    }
    if (app.state === 'maintenance') {
        return { tone: 'maintenance', title: 'DevEye est en maintenance', detail: null, message: app.message };
    }
    const down = others.filter((c) => c.state === 'down' && !c.inherited).length;
    const troubled = others.filter((c) => (c.state === 'degraded' || c.state === 'maintenance') && !c.inherited).length;
    if (down > 0) {
        return {
            tone: 'down',
            title: `Panne en cours sur ${plural(down, 'service')}`,
            detail: troubled > 0 ? `et des perturbations sur ${plural(troubled, 'autre')}` : null,
            message: null
        };
    }
    if (app.state === 'degraded') {
        return { tone: 'degraded', title: 'Service perturbé', detail: app.reason, message: null };
    }
    if (troubled > 0) {
        return {
            tone: 'degraded',
            title: `Perturbations sur ${plural(troubled, 'service')}`,
            detail: null,
            message: null
        };
    }
    return { tone: 'up', title: 'Tous les services fonctionnent', detail: null, message: null };
}

function featureBanner(c: ComponentRow): StatusView['banner'] {
    const name = `« ${c.label} »`;
    switch (c.state) {
        case null:
            return { tone: 'pending', title: 'Vérification en cours', detail: null, message: null };
        case 'up':
            return { tone: 'up', title: `${name} fonctionne`, detail: null, message: null };
        case 'degraded':
            return { tone: 'degraded', title: `Perturbations sur ${name}`, detail: c.reason, message: null };
        case 'maintenance':
            return c.inherited
                ? { tone: 'maintenance', title: 'DevEye est en maintenance', detail: null, message: c.message }
                : { tone: 'maintenance', title: `${name} est en maintenance`, detail: null, message: null };
        case 'down':
            return c.inherited
                ? { tone: 'down', title: 'DevEye est hors service', detail: c.reason, message: null }
                : { tone: 'down', title: `${name} est hors service`, detail: c.reason, message: null };
    }
}

/** La vue d'ensemble, ou celle d'une fonctionnalité ; `null` pour un identifiant inconnu. */
export function buildView(input: ViewInput, featureId: string | null): StatusView | null {
    const listed = input.components.filter((c) => c.listed);
    const labels = new Map(input.components.map((c) => [c.id, c.label]));
    const app = listed.find((c) => c.kind === 'app');
    const features = listed.filter((c) => c.kind === 'feature');
    const picker = features.map((c) => ({ id: c.id, label: c.label, state: shown(c) }));

    if (featureId === null) {
        const main = listed.filter((c) => c.kind !== 'feature');
        // Les fonctionnalités touchées en ce moment, d'elles-mêmes : le reste est dans le sélecteur.
        const troubled = features.filter((c) => c.state !== null && c.state !== 'up' && !c.inherited);
        const { ongoing, history } = incidentsOf(
            listed.map((c) => c.id),
            labels,
            input
        );
        return {
            generatedAt: input.now,
            feature: null,
            banner: overviewBanner(
                app,
                listed.filter((c) => c.kind !== 'app')
            ),
            components: [...main, ...troubled].map((c) => componentView(c, input)),
            ongoing,
            history,
            picker
        };
    }

    const feature = features.find((c) => c.id === featureId);
    if (!feature) return null;
    const { ongoing, history } = incidentsOf([feature.id, ...(app ? [app.id] : [])], labels, input);
    return {
        generatedAt: input.now,
        feature: { id: feature.id, label: feature.label },
        banner: featureBanner(feature),
        components: [componentView(feature, input)],
        ongoing,
        history,
        picker
    };
}
