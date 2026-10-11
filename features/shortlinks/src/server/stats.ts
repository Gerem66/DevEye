import type { SdkCipher } from '@deveye/types/sdk/server';

import {
    SHORTLINK_DIMENSIONS,
    type ShortlinkDimension,
    type ShortlinkPoint,
    type ShortlinkRange,
    type ShortlinkStats,
    type ShortlinkTopRow
} from '../contracts/domain';
import { DAY, dayOf, now } from './_shared';
import type { ShortlinksRepo } from './repo';

const TOP = 10;
/** Les sites d'origine se fusionnent par nom après déchiffrement : on en lit un peu plus que le classement n'en montre. */
const REFERRER_READ = 30;

/** Les jours d'une période, et la taille de ses points : un jour, ou une semaine sur douze mois. */
export function rangeWindow(range: ShortlinkRange, today: number): { from: number; to: number; step: number } {
    switch (range) {
        case '7d':
            return { from: today - 6, to: today, step: 1 };
        case '30d':
            return { from: today - 29, to: today, step: 1 };
        case '90d':
            return { from: today - 89, to: today, step: 1 };
        case '12m':
            return { from: today - 52 * 7 + 1, to: today, step: 7 };
    }
}

/** La série complète, jours sans passage compris, regroupée par pas. */
export function bucketSeries(
    rows: readonly { day: number; clicks: number; visits: number }[],
    window: { from: number; to: number; step: number }
): ShortlinkPoint[] {
    const byDay = new Map(rows.map((row) => [row.day, row]));
    const points: ShortlinkPoint[] = [];
    for (let start = window.from; start <= window.to; start += window.step) {
        let clicks = 0;
        let visits = 0;
        for (let day = start; day < start + window.step && day <= window.to; day++) {
            const row = byDay.get(day);
            if (row) {
                clicks += row.clicks;
                visits += row.visits;
            }
        }
        points.push({ at: start * DAY, clicks, visits });
    }
    return points;
}

export interface StatsInput {
    repo: ShortlinksRepo;
    linkIds: readonly number[];
    range: ShortlinkRange;
    /** La clé de l'espace d'une étiquette : celle du domicile des liens projetés. */
    cipherOf(workspaceId: number): Promise<SdkCipher | null>;
    attribution: { text: string; url: string };
}

export async function buildStats(input: StatsInput): Promise<ShortlinkStats> {
    const window = rangeWindow(input.range, dayOf(now()));
    const span = window.to - window.from + 1;
    const { repo, linkIds } = input;
    const [rows, before, ...dims] = await Promise.all([
        repo.stats.series(linkIds, window.from, window.to),
        repo.stats.series(linkIds, window.from - span, window.from - 1),
        ...SHORTLINK_DIMENSIONS.map((kind) =>
            repo.stats.dims(linkIds, kind, window.from, window.to, kind === 'referrer' ? REFERRER_READ : TOP)
        )
    ]);
    const sum = (list: readonly { clicks: number; visits: number }[]) =>
        list.reduce((acc, row) => ({ clicks: acc.clicks + row.clicks, visits: acc.visits + row.visits }), {
            clicks: 0,
            visits: 0
        });
    const totals = sum(rows);
    const top = {} as Record<ShortlinkDimension, ShortlinkTopRow[]>;
    SHORTLINK_DIMENSIONS.forEach((kind, i) => {
        top[kind] = dims[i].map((row) => ({ label: row.value, visits: row.visits }));
    });
    top.referrer = await namedReferrers(input, dims[SHORTLINK_DIMENSIONS.indexOf('referrer')]);
    return {
        range: input.range,
        bucket: window.step === 1 ? 'day' : 'week',
        series: bucketSeries(rows, window),
        totals: { ...totals, bots: rows.reduce((acc, row) => acc + row.bots, 0) },
        previous: sum(before),
        top,
        attribution: input.attribution
    };
}

/**
 * Les sites d'origine, nommés : chaque identifiant d'étiquette s'ouvre avec la
 * clé de l'espace qui l'a écrite, et deux étiquettes au même nom (deux espaces,
 * ou une rotation des clés) se fusionnent.
 */
async function namedReferrers(
    input: StatsInput,
    rows: readonly { value: string; visits: number }[]
): Promise<ShortlinkTopRow[]> {
    const ids = rows.filter((row) => row.value !== '').map((row) => Number(row.value));
    const labels = await input.repo.stats.labels(ids);
    const names = new Map<string, string>();
    for (const label of labels) {
        const cipher = await input.cipherOf(Number(label.workspace_id));
        const name = cipher === null ? null : await cipher.tryDecrypt(label.content);
        if (name !== null) names.set(String(label.id), name);
    }
    const merged = new Map<string, number>();
    for (const row of rows) {
        const name = row.value === '' ? '' : names.get(row.value);
        if (name === undefined) continue;
        merged.set(name, (merged.get(name) ?? 0) + row.visits);
    }
    return [...merged]
        .map(([label, visits]) => ({ label, visits }))
        .sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label))
        .slice(0, TOP);
}
