import type { DeployCandidate, DeployStatus } from '../../contracts/domain';

// Le garde des appels sortants, partagé par toute l'app : le journal d'un job
// arrive par une redirection vers un stockage tiers, que le garde revérifie et
// vers lequel le jeton ne suit pas.
import { safeFetch, UnsafeTargetError } from '@/Services/netFetch';

import {
    ProviderError,
    type DeployProviderAdapter,
    type ProviderAccess,
    type ProviderTarget,
    type ReadOptions,
    type RemoteDeployment,
    type TargetPlace
} from './types';

/**
 * GitHub Actions derrière le contrat du module : une cible est un workflow
 * d'un dépôt, lancé par `workflow_dispatch` sur une branche. L'API ne rend pas
 * l'exécution créée : le suivi la rattache par la date, comme un déploiement
 * Dokploy parti sans identifiant.
 *
 * Le jeton est celui de l'accès, propre à Déploiements : à grain fin, Actions
 * en lecture et écriture, Contents en lecture.
 */

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 20_000;

/** Les dépôts parcourus pour proposer des workflows : les plus récemment poussés. */
const CANDIDATE_REPOS = 30;
/** Dépôts lus à la fois pour le catalogue. */
const CANDIDATE_CONCURRENCY = 4;
/** Durée de vie du catalogue d'un accès : un sélecteur rouvert ne relit pas trente dépôts. */
const CANDIDATES_TTL_SECONDS = 300;
/** Jobs dont le journal complet est rapatrié. */
const LOG_JOBS_MAX = 10;
/** Au-delà, le journal complet ne garde que sa fin : un build verbeux pèse plusieurs mégaoctets. */
const LOG_MAX_CHARS = 1_000_000;

interface GhRepo {
    full_name: string;
    default_branch: string;
    archived?: boolean;
}

interface GhWorkflow {
    id: number;
    name: string;
    path: string;
    state: string;
}

interface GhRun {
    id: number;
    name: string | null;
    display_title?: string | null;
    status: string | null;
    conclusion: string | null;
    head_branch: string | null;
    html_url: string;
    run_started_at?: string | null;
    created_at: string;
    updated_at: string;
}

interface GhStep {
    name: string;
    status: string;
    conclusion: string | null;
}

interface GhJob {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    steps?: GhStep[];
}

/** `propriétaire/dépôt#identifiant` : le dépôt et le workflow d'une cible. */
export function parseWorkflowId(externalId: string): { repo: string; workflowId: string } {
    const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(externalId);
    if (!match) throw new ProviderError('Identifiant de workflow illisible (propriétaire/dépôt#identifiant).', 0);
    return { repo: match[1], workflowId: match[2] };
}

function authHeaders(access: ProviderAccess): Record<string, string> {
    return {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${access.secret}`,
        'x-github-api-version': API_VERSION,
        'user-agent': 'DevEye'
    };
}

/**
 * L'instant où revenir quand GitHub limite le débit ; `null` sinon. Au compteur
 * ou au délai annoncé, jamais au seul code : un 403 est aussi un droit manquant.
 */
function retryAtOf(status: number, headers: { get(name: string): string | null }): number | null {
    if (status !== 403 && status !== 429) return null;
    const now = Math.floor(Date.now() / 1000);
    const after = Number(headers.get('retry-after'));
    if (Number.isFinite(after) && after > 0) return now + after;
    if (headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(headers.get('x-ratelimit-reset'));
        return Number.isFinite(reset) && reset > now ? reset : now + 60;
    }
    return null;
}

function refusalOf(status: number, body: unknown): string {
    if (status === 401) return 'Jeton GitHub refusé : il a expiré ou été révoqué.';
    if (status === 403) {
        return 'Ce jeton GitHub n’a pas le droit demandé (Actions en lecture et écriture, Contents en lecture).';
    }
    if (status === 404) return 'Dépôt ou workflow introuvable pour ce jeton.';
    const message =
        body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
            ? (body as { message: string }).message
            : null;
    return message ? `GitHub : ${message}` : `GitHub a répondu ${status}.`;
}

/** Un appel à l'API ; `data` vaut `null` sur 204 et sur 304 (ETag inchangé). */
async function call<T>(
    access: ProviderAccess,
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; etag?: string | null } = {}
): Promise<{ status: number; data: T | null; etag: string | null }> {
    let res: Awaited<ReturnType<typeof safeFetch>>;
    try {
        res = await safeFetch(`${API}${path}`, {
            method: init.method ?? 'GET',
            headers: {
                ...authHeaders(access),
                ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
                ...(init.etag ? { 'if-none-match': init.etag } : {})
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS)
        });
    } catch (e) {
        if (e instanceof UnsafeTargetError) throw new ProviderError(e.message, 0);
        throw new ProviderError('GitHub injoignable.', 0);
    }
    if (res.status === 304) return { status: 304, data: null, etag: init.etag ?? null };

    const retryAt = retryAtOf(res.status, res.headers);
    if (retryAt !== null) {
        throw new ProviderError(
            'Limite de l’API GitHub atteinte pour ce jeton : le suivi reprendra seul.',
            res.status,
            retryAt
        );
    }
    if (res.status === 204) return { status: 204, data: null, etag: null };

    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new ProviderError(refusalOf(res.status, body), res.status);
    return { status: res.status, data: body as T, etag: res.headers.get('etag') };
}

/** `items` traités `limit` à la fois : trente dépôts ne partent pas en trente requêtes simultanées. */
async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) await run(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function seconds(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Les quatre états du module. `waiting` (une approbation d'environnement) attend comme une file. */
function statusOf(run: Pick<GhRun, 'status' | 'conclusion'>): DeployStatus {
    if (run.status === 'completed') return run.conclusion === 'success' ? 'success' : 'failed';
    if (run.status === 'in_progress') return 'running';
    return 'queued';
}

const CONCLUSIONS: Record<string, string> = {
    failure: 'Le workflow a échoué.',
    cancelled: 'Exécution annulée.',
    timed_out: 'Délai d’exécution dépassé.',
    skipped: 'Exécution sautée.',
    action_required: 'Une approbation est requise sur GitHub.',
    startup_failure: 'Le workflow n’a pas pu démarrer.',
    stale: 'Exécution périmée.',
    neutral: 'Conclusion neutre.'
};

export function toRemote(run: GhRun): RemoteDeployment {
    const status = statusOf(run);
    const terminal = status === 'success' || status === 'failed';
    const details = [
        { name: '⚙️ Workflow', value: run.name ?? '' },
        { name: '🌿 Branche', value: run.head_branch ?? '' }
    ].filter((d) => d.value);
    return {
        externalId: String(run.id),
        status,
        title: run.display_title || run.name || 'Exécution',
        description:
            status === 'failed'
                ? (CONCLUSIONS[run.conclusion ?? ''] ?? `Conclusion : ${run.conclusion ?? 'inconnue'}.`)
                : '',
        startedAt: seconds(run.run_started_at) ?? seconds(run.created_at) ?? Math.floor(Date.now() / 1000),
        finishedAt: terminal ? seconds(run.updated_at) : null,
        logRef: String(run.id),
        url: run.html_url,
        details
    };
}

function markOf(unit: { status: string; conclusion: string | null }): string {
    if (unit.status === 'in_progress') return '▶';
    if (unit.status !== 'completed') return '·';
    if (unit.conclusion === 'success') return '✓';
    if (unit.conclusion === 'skipped') return '-';
    return '✗';
}

/**
 * Les étapes des jobs, une ligne chacune, comme la page d'une exécution. Les
 * étapes pas encore commencées se résument en une ligne : l'avis ne montre que
 * la fin du bloc, et c'est là que doit se lire l'étape en cours.
 */
export function stepsOf(jobs: readonly GhJob[]): string {
    const lines: string[] = [];
    for (const job of jobs) {
        lines.push(`${markOf(job)} ${job.name}`);
        const steps = job.steps ?? [];
        const pending = steps.filter((s) => s.status !== 'completed' && s.status !== 'in_progress').length;
        for (const step of steps) {
            if (step.status === 'completed' || step.status === 'in_progress')
                lines.push(`  ${markOf(step)} ${step.name}`);
        }
        if (pending > 0 && job.status !== 'completed') {
            lines.push(`  · ${pending} étape${pending > 1 ? 's' : ''} à venir`);
        }
    }
    return lines.join('\n');
}

/** Les horodatages que GitHub met en tête de chaque ligne de journal : du bruit à l'écran. */
const LINE_TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/gm;

/** Le message d'un `workflow_dispatch` refusé, dit dans les mots de celui qui l'a lancé. */
function dispatchRefusal(error: ProviderError, ref: string): ProviderError {
    if (error.status !== 422) return error;
    if (error.message.includes('workflow_dispatch')) {
        return new ProviderError(
            'Ce workflow ne se lance pas à la main : ajoutez `workflow_dispatch` à son `on:`.',
            error.status
        );
    }
    if (error.message.includes('No ref found')) {
        return new ProviderError(`La branche « ${ref} » n’existe pas dans ce dépôt.`, error.status);
    }
    return error;
}

export class GithubProvider implements DeployProviderAdapter {
    readonly id = 'github' as const;
    readonly kinds = ['workflow'] as const;

    private readonly catalogs = new Map<number, { at: number; candidates: DeployCandidate[] }>();
    /** Les exécutions d'un workflow, par accès et chemin, avec leur ETag : un 304 ne coûte rien au quota. */
    private readonly runs = new Map<string, { etag: string | null; runs: GhRun[] }>();
    private readonly branches = new Map<string, string>();

    location(_access: Pick<ProviderAccess, 'baseUrl'>, target: ProviderTarget): string | null {
        try {
            return `github.com/${parseWorkflowId(target.externalId).repo}`;
        } catch {
            return 'github.com';
        }
    }

    async candidates(access: ProviderAccess): Promise<DeployCandidate[]> {
        const now = Math.floor(Date.now() / 1000);
        const cached = this.catalogs.get(access.credentialId);
        if (cached && now - cached.at <= CANDIDATES_TTL_SECONDS) return cached.candidates;

        const repos = ((await call<GhRepo[]>(access, '/user/repos?per_page=100&sort=pushed')).data ?? [])
            .filter((r) => !r.archived)
            .slice(0, CANDIDATE_REPOS);
        const found: DeployCandidate[] = [];
        await eachLimited(repos, CANDIDATE_CONCURRENCY, async (repo) => {
            this.branches.set(`${access.credentialId}:${repo.full_name}`, repo.default_branch);
            try {
                const res = await call<{ workflows: GhWorkflow[] }>(
                    access,
                    `/repos/${repo.full_name}/actions/workflows?per_page=100`
                );
                for (const wf of res.data?.workflows ?? []) {
                    if (wf.state !== 'active') continue;
                    found.push({
                        kind: 'workflow',
                        externalId: `${repo.full_name}#${wf.id}`,
                        name: wf.name,
                        path: `${repo.full_name} · ${wf.path.replace(/^\.github\/workflows\//, '')}`,
                        ref: repo.default_branch
                    });
                }
            } catch (e) {
                // Un dépôt dont le jeton ne lit pas les Actions est simplement
                // absent ; une limite de débit, elle, interrompt tout.
                if (e instanceof ProviderError && e.retryAt !== null) throw e;
            }
        });
        found.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.name.localeCompare(b.name));
        this.catalogs.set(access.credentialId, { at: now, candidates: found });
        return found;
    }

    async trigger(access: ProviderAccess, target: ProviderTarget): Promise<void> {
        const { repo, workflowId } = parseWorkflowId(target.externalId);
        const ref = target.ref ?? (await this.defaultBranch(access, repo));
        try {
            await call(access, `/repos/${repo}/actions/workflows/${workflowId}/dispatches`, {
                method: 'POST',
                body: { ref }
            });
        } catch (e) {
            throw e instanceof ProviderError ? dispatchRefusal(e, ref) : e;
        }
    }

    async history(
        access: ProviderAccess,
        target: ProviderTarget,
        options: ReadOptions = {}
    ): Promise<RemoteDeployment[]> {
        const { repo, workflowId } = parseWorkflowId(target.externalId);
        const branch = target.ref ? `&branch=${encodeURIComponent(target.ref)}` : '';
        const path = `/repos/${repo}/actions/workflows/${workflowId}/runs?per_page=20${branch}`;
        const key = `${access.credentialId}:${path}`;
        const known = this.runs.get(key);
        const res = await call<{ workflow_runs: GhRun[] }>(access, path, {
            timeoutMs: options.timeoutMs,
            etag: known?.etag ?? null
        });
        const runs = res.status === 304 && known ? known.runs : (res.data?.workflow_runs ?? []);
        if (res.status !== 304) this.runs.set(key, { etag: res.etag, runs });
        return runs.map(toRemote);
    }

    async noticeLog(
        access: ProviderAccess,
        target: ProviderTarget,
        entry: RemoteDeployment,
        options: ReadOptions = {}
    ): Promise<string> {
        if (!entry.logRef) return '';
        return stepsOf(await this.jobs(access, target, entry.logRef, options));
    }

    async fullLog(access: ProviderAccess, target: ProviderTarget, entry: RemoteDeployment): Promise<string> {
        if (!entry.logRef) throw new ProviderError('Aucun journal pour cette exécution.', 404);
        const { repo } = parseWorkflowId(target.externalId);
        const jobs = await this.jobs(access, target, entry.logRef);
        const parts: string[] = [];
        for (const job of jobs.slice(0, LOG_JOBS_MAX)) {
            const text = await this.jobLog(access, repo, job.id).catch(() => 'Journal indisponible pour ce job.');
            parts.push(`=== ${job.name} ===\n${text}`);
        }
        const log = parts.join('\n\n');
        return log.length > LOG_MAX_CHARS ? `…${log.slice(-LOG_MAX_CHARS)}` : log;
    }

    async place(
        _access: ProviderAccess,
        target: ProviderTarget,
        entry: RemoteDeployment,
        fallbackName: string
    ): Promise<TargetPlace> {
        const repo = this.location({ baseUrl: null }, target)?.replace(/^github\.com\//, '') ?? fallbackName;
        const details = entry.details.length > 0 ? entry.details : [{ name: '⚙️ Workflow', value: fallbackName }];
        return {
            fields: [{ name: '🐙 Dépôt', value: repo }, ...details, { name: '📦 Type', value: 'workflow' }],
            link: entry.url ? { name: '🔗 GitHub', label: 'Ouvrir l’exécution', url: entry.url } : null
        };
    }

    async repoUrl(_access: ProviderAccess, target: ProviderTarget): Promise<string | null> {
        try {
            return `https://github.com/${parseWorkflowId(target.externalId).repo}`;
        } catch {
            return null;
        }
    }

    private async jobs(
        access: ProviderAccess,
        target: ProviderTarget,
        runId: string,
        options: ReadOptions = {}
    ): Promise<GhJob[]> {
        const { repo } = parseWorkflowId(target.externalId);
        const res = await call<{ jobs: GhJob[] }>(access, `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, {
            timeoutMs: options.timeoutMs
        });
        return res.data?.jobs ?? [];
    }

    /** Le texte brut d'un job : GitHub redirige vers un fichier, que le garde suit sans le jeton. */
    private async jobLog(access: ProviderAccess, repo: string, jobId: number): Promise<string> {
        const res = await safeFetch(`${API}/repos/${repo}/actions/jobs/${jobId}/logs`, {
            headers: authHeaders(access),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (!res.ok) throw new ProviderError(refusalOf(res.status, null), res.status);
        return (await res.text()).replace(LINE_TIMESTAMP, '');
    }

    private async defaultBranch(access: ProviderAccess, repo: string): Promise<string> {
        const key = `${access.credentialId}:${repo}`;
        const known = this.branches.get(key);
        if (known) return known;
        const branch = (await call<GhRepo>(access, `/repos/${repo}`)).data?.default_branch ?? 'main';
        this.branches.set(key, branch);
        return branch;
    }
}
