import { logFailure, type FeatureService, type FeatureServiceDeps } from '@deveye/types/sdk/server';

// Le garde des appels sortants, partagé par toute l'app : la destination est
// choisie par un membre, et le contrôle ne doit mener ni au réseau privé du
// serveur ni en boucle.
import { safeFetch } from '@/Services/netFetch';

import { DAY, now, openContent } from './_shared';
import type { LinkRow, ShortlinksRepo } from './repo';

/**
 * Le contrôle des destinations : chaque jour, chaque lien actif qui le demande
 * va voir si sa destination répond encore. Un premier échec se revérifie dans
 * l'heure ; le second fait passer le lien en « destination injoignable » et
 * prévient. Une destination partagée par plusieurs liens qui tombe fait un
 * seul avis, qui les nomme, vers les canaux de tous.
 */

const TICK_MS = 10 * 60_000;
const BATCH = 50;
const RETRY_SECONDS = 3_600;
const TIMEOUT_MS = 10_000;

export type CheckVerdict = { ok: true } | { ok: false; error: string };

/** Une catégorie lisible, jamais un message réseau qui nommerait la destination. */
function categoryOf(error: unknown): string {
    const name = (error as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') return 'délai dépassé';
    if (name === 'UnsafeTargetError') return 'adresse refusée';
    const code = String((error as { cause?: { code?: unknown } }).cause?.code ?? '');
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'nom introuvable';
    if (code === 'ECONNREFUSED') return 'connexion refusée';
    if (code.startsWith('CERT_') || code.includes('TLS') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
        return 'certificat refusé';
    return 'injoignable';
}

async function probe(url: string): Promise<CheckVerdict> {
    const headers = { 'user-agent': 'DevEye-Liens/1.0 (contrôle des destinations)' };
    try {
        let res = await safeFetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        // Bien des sites refusent HEAD sans être en panne : on redemande la page.
        if (res.status === 405 || res.status === 501 || res.status === 403) {
            res = await safeFetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
            await res.body?.cancel();
        }
        return res.status < 400 ? { ok: true } : { ok: false, error: `code ${res.status}` };
    } catch (error) {
        return { ok: false, error: categoryOf(error) };
    }
}

export interface CheckerSeam {
    probe?(url: string): Promise<CheckVerdict>;
}

export interface Checker {
    service(): FeatureService;
    /** Une vérification tout de suite, sans seconde chance : c'est un membre qui la demande. */
    checkNow(row: LinkRow): Promise<void>;
}

export function createChecker(deps: FeatureServiceDeps<ShortlinksRepo>, seam: CheckerSeam = {}): Checker {
    const check = seam.probe ?? probe;
    /** Les liens en sursis : un premier échec, revérifié dans l'heure. Un redémarrage leur rend une chance. */
    const strikes = new Set<number>();

    /** Toutes les destinations du lien (commune, iPhone, Android) : une seule en panne suffit. */
    async function verdictOf(row: LinkRow): Promise<{ verdict: CheckVerdict; host: string; title: string }> {
        const content = await openContent(deps.cipherFor(row.workspace_id), row.content);
        const urls = [content.targets.default, content.targets.ios, content.targets.android].filter(
            (url): url is string => typeof url === 'string' && url.length > 0
        );
        let host = '';
        try {
            host = new URL(content.targets.default).host;
        } catch {
            return { verdict: { ok: false, error: 'destination illisible' }, host, title: content.title };
        }
        for (const url of new Set(urls)) {
            const verdict = await check(url);
            if (!verdict.ok) return { verdict, host, title: content.title };
        }
        return { verdict: { ok: true }, host, title: content.title };
    }

    interface Change {
        row: LinkRow;
        host: string;
        title: string;
        error: string | null;
    }

    /** Un avis par espace et par destination, qui compte et nomme les liens touchés. */
    async function tell(changes: readonly Change[], broken: boolean): Promise<void> {
        const groups = new Map<string, Change[]>();
        for (const change of changes) {
            const key = `${change.row.workspace_id}:${change.host}`;
            groups.set(key, [...(groups.get(key) ?? []), change]);
        }
        for (const group of groups.values()) {
            const [first] = group;
            const names = group.slice(0, 3).map((c) => `« ${c.title || c.row.code} »`);
            const more = group.length > 3 ? ` et ${group.length - 3} autre(s)` : '';
            const what =
                group.length === 1 ? `Le lien ${names[0]}` : `${group.length} liens (${names.join(', ')}${more})`;
            const alert = broken
                ? {
                      subject: `Destination injoignable : ${first.host}`,
                      body: `${what} mène${group.length === 1 ? '' : 'nt'} à ${first.host}, qui ne répond plus (${first.error ?? 'injoignable'}). Les visiteurs arrivent sur une page en erreur.`
                  }
                : {
                      subject: `Destination rétablie : ${first.host}`,
                      body: `${what} mène${group.length === 1 ? '' : 'nt'} de nouveau à une page qui répond.`
                  };
            await deps
                .deveyeFor(first.row.workspace_id)
                .notify.send(alert, { itemIds: group.map((c) => c.row.id) })
                .catch((error: unknown) =>
                    deps.logger.warn({ err: error }, 'shortlinks: avis de destination non parti')
                );
        }
    }

    async function judge(rows: readonly LinkRow[], secondChance: boolean): Promise<void> {
        const at = now();
        const broke: Change[] = [];
        const recovered: Change[] = [];
        for (const row of rows) {
            const wasBroken = row.check_state === 'broken';
            const { verdict, host, title } = await verdictOf(row);
            if (verdict.ok) {
                strikes.delete(row.id);
                await deps.repo.links.saveCheck(row.id, { state: 'ok', error: null, at, due: at + DAY });
                if (wasBroken) recovered.push({ row, host, title, error: null });
                continue;
            }
            // Un premier échec d'un lien qui marchait : on revérifie avant de prévenir.
            if (secondChance && !wasBroken && !strikes.has(row.id)) {
                strikes.add(row.id);
                await deps.repo.links.saveCheck(row.id, { error: verdict.error, at, due: at + RETRY_SECONDS });
                continue;
            }
            strikes.delete(row.id);
            await deps.repo.links.saveCheck(row.id, { state: 'broken', error: verdict.error, at, due: at + DAY });
            if (!wasBroken) broke.push({ row, host, title, error: verdict.error });
            logFailure(
                deps.logger,
                true,
                { linkId: row.id, error: verdict.error },
                'shortlinks: destination injoignable'
            );
        }
        await tell(broke, true);
        await tell(recovered, false);
    }

    return {
        service: () =>
            deps.createTicker({
                intervalMs: TICK_MS,
                tick: async () => {
                    const due = await deps.repo.links.dueChecks(now(), BATCH);
                    // Un lien que l'offre tient en pause ne coûte rien, contrôle compris : son tour passe.
                    const paused = due.filter((row) => deps.pauses.isPaused('links', String(row.id)));
                    for (const row of paused) {
                        await deps.repo.links.saveCheck(row.id, { error: null, at: now(), due: now() + DAY });
                    }
                    await judge(
                        due.filter((row) => !paused.includes(row)),
                        true
                    );
                }
            }),
        checkNow: (row) => judge([row], false)
    };
}
