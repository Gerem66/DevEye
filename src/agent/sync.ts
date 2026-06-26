import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { AGENT_TARGETS, agentManifestSchema, type AgentManifest } from 'deveye-types';

import { env } from '@/Utils/Env';
import { logger } from '@/logger';
import { status } from '@/status';
import { appVersion } from '@/version';
import { createGithubAgentSource, type AgentSource } from './source';

const TASK_ID = 'agent-sync';
const TASK_LABEL = 'Synchronisation des agents';
const MANIFEST_FILE = 'manifest.json';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Directory holding the served agent binaries. From `AGENT_DIST_DIR` (absolute,
 * or relative to the server cwd), defaulting to `agent/dist`. On a persistent
 * volume in prod so a sync survives redeploys.
 */
export function agentDistDir(): string {
    const v = env.AGENT_DIST_DIR;
    if (!v) return resolve(process.cwd(), 'agent', 'dist');
    return isAbsolute(v) ? v : resolve(process.cwd(), v);
}

async function sha256OfFile(path: string): Promise<string | null> {
    try {
        return createHash('sha256')
            .update(await readFile(path))
            .digest('hex');
    } catch {
        return null;
    }
}

async function fileExists(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

/**
 * Manifest of the binaries currently on disk (written after each successful
 * sync). A pure local read — this is how the runtime knows the served version
 * without ever calling GitHub.
 */
export async function readSyncedManifest(distDir: string): Promise<AgentManifest | null> {
    try {
        const raw = await readFile(join(distDir, MANIFEST_FILE), 'utf-8');
        const parsed = agentManifestSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

let manifestCache: { at: number; value: AgentManifest | null } | null = null;

/**
 * Cached `readSyncedManifest` for the hot path (every `device.list` consults it
 * to flag self-updatable agents). The synced manifest only changes at the bounded
 * boot reconcile, so a short TTL bounds disk reads while still reflecting a sync.
 */
export async function readServedManifestCached(distDir: string, ttlMs = 5000): Promise<AgentManifest | null> {
    const now = Date.now();
    if (manifestCache && now - manifestCache.at < ttlMs) return manifestCache.value;
    const value = await readSyncedManifest(distDir);
    manifestCache = { at: now, value };
    return value;
}

/** Download every target whose on-disk sha differs from the manifest (verified + atomic). */
async function downloadDiffs(source: AgentSource, manifest: AgentManifest, distDir: string): Promise<string[]> {
    const errors: string[] = [];
    const total = manifest.targets.length;
    let synced = 0;
    for (const t of manifest.targets) {
        const dest = join(distDir, t.filename);
        if ((await sha256OfFile(dest)) === t.sha256) {
            synced++;
            continue;
        }
        status.update(TASK_ID, {
            state: 'running',
            detail: `Téléchargement ${t.filename} (${synced}/${total})`,
            progress: synced / total
        });
        try {
            const bytes = await source.fetchBinary(t.filename);
            if (createHash('sha256').update(bytes).digest('hex') !== t.sha256) throw new Error('checksum invalide');
            const tmp = `${dest}.tmp-${process.pid}`;
            await writeFile(tmp, bytes);
            if (!t.filename.endsWith('.exe')) await chmod(tmp, 0o755);
            await rename(tmp, dest); // atomic replace
            synced++;
        } catch (e) {
            errors.push(`${t.filename}: ${(e as Error).message}`);
        }
    }
    return errors;
}

/** How many of the shippable targets are present on disk right now. */
async function presentCount(distDir: string): Promise<number> {
    const present = await Promise.all(AGENT_TARGETS.map((t) => fileExists(join(distDir, t.filename))));
    return present.filter(Boolean).length;
}

/**
 * Settle the task `done` (ready) with a usable set on disk — possibly partial, or
 * an older version than `want` while the matching build is still pending. Per-target
 * gaps and version mismatches are surfaced as a non-blocking detail/error (shown in
 * the download popup), never held against the whole app's readiness.
 */
function settleServing(distDir: string, errors: string[], want: string, available: number): Promise<void> {
    return readSyncedManifest(distDir).then((manifest) => {
        const version = manifest?.version ?? null;
        const mismatch = version !== null && version !== want;
        status.update(TASK_ID, {
            state: 'done',
            progress: 1,
            error: errors.length ? errors.join(' · ') : null,
            detail: mismatch
                ? `Version ${version} (serveur ${want})`
                : version
                  ? `Version ${version}`
                  : `${available}/${AGENT_TARGETS.length} binaires`
        });
    });
}

/**
 * Settle the task `error` when not a single agent binary could be obtained — e.g. a
 * first deploy whose agent build failed and left nothing on the (empty) volume. The
 * app still runs (binaries only power download + self-update), but this is a real
 * deployment problem worth surfacing, so the topbar keeps a clear, frozen error chip
 * rather than a spinner (the client stops polling once a task reaches a terminal state).
 */
function settleEmpty(want: string, errors: string[]): void {
    status.update(TASK_ID, {
        state: 'error',
        progress: null,
        detail: null,
        error: errors.length ? errors.join(' · ') : `Build des agents indisponible (version ${want})`
    });
}

interface ReconcileOptions {
    source: AgentSource;
    distDir: string;
    want: string;
    maxWaitMs: number;
    pollMs: number;
}

/**
 * Boot-time reconcile (bounded, terminating). Fetches the manifest and downloads
 * only the changed binaries.
 *
 * Readiness is **never** held on getting *this* deploy's exact version: the agent
 * binaries are an optional capability (download + self-update), so the moment a
 * usable set is on disk — typically a prior deploy's, on the persistent volume —
 * the task settles `done` and the app is ready, while it keeps chasing `want` in
 * the background until it lands or the cap is hit. That way a slow *or failed*
 * agent build no longer spins the boot loader: it resolves at once on whatever is
 * already served. The blocking loader only persists while there is genuinely
 * nothing to serve yet (e.g. a first deploy, mid-build); if even the deadline
 * passes with nothing, the task ends in a clear error (not an endless spinner).
 * No steady-state polling.
 */
export async function reconcileAgents({ source, distDir, want, maxWaitMs, pollMs }: ReconcileOptions): Promise<void> {
    status.update(TASK_ID, { state: 'running', detail: 'Recherche du manifeste…', progress: null });
    await mkdir(distDir, { recursive: true });

    const deadline = Date.now() + maxWaitMs;
    let lastErrors: string[] = [];
    for (;;) {
        const manifest = await source.fetchManifest();
        if (manifest) {
            lastErrors = await downloadDiffs(source, manifest, distDir);
            if (lastErrors.length === 0) {
                // Persist so the runtime knows the served version with zero GitHub.
                await writeFile(join(distDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
                // Got exactly what this deploy wants → fully done.
                if (manifest.version === want) {
                    return settleServing(distDir, [], want, await presentCount(distDir));
                }
            }
        }

        const available = await presentCount(distDir);
        const reached = Date.now() >= deadline;
        if (available > 0) {
            // Ready: serve what we have (older / partial set) and keep chasing `want`
            // in the background. Once settled this never re-blocks — the files stay on
            // disk, so we always take this branch from here on.
            await settleServing(distDir, lastErrors, want, available);
            if (reached) return;
        } else if (reached) {
            // Deadline hit with nothing to serve (first deploy + a build that's late
            // or failed): settle on a clear error instead of spinning forever.
            return settleEmpty(want, lastErrors);
        } else {
            // Still nothing usable, within the window: keep the loader up. Drop the
            // bar to null so it's loader-only (`status.update` patches, so progress
            // would otherwise stay stuck at the last downloadDiffs value).
            status.update(TASK_ID, {
                state: 'running',
                progress: null,
                detail: manifest ? `En attente de la version ${want}…` : 'Manifeste indisponible, nouvel essai…'
            });
        }
        await sleep(pollMs);
    }
}

/**
 * Kick the boot reconcile (non-blocking). Registers the readiness task, then —
 * if an upstream token is configured — reconciles in the background. With no
 * token (typical dev), it just serves whatever is already on disk.
 */
export function startAgentReconcile(distDir: string): void {
    status.register(TASK_ID, TASK_LABEL);

    const token = env.AGENT_DOWNLOAD_TOKEN || process.env.GITHUB_PACKAGES_TOKEN || '';
    const repo = env.AGENT_REPO || '';
    if (!token || !repo) {
        // No upstream configured (no token, or AGENT_REPO unset): serve disk only.
        status.update(TASK_ID, { state: 'done', progress: 1, detail: 'Synchronisation désactivée (hors ligne)' });
        return;
    }

    const source = createGithubAgentSource({
        repo,
        tag: env.AGENT_RELEASE_TAG || 'agent-latest',
        token
    });

    void reconcileAgents({ source, distDir, want: appVersion(), maxWaitMs: 20 * 60_000, pollMs: 20_000 }).catch((e) => {
        logger.error({ err: (e as Error).message }, 'Agent reconcile crashed');
        status.update(TASK_ID, { state: 'error', error: (e as Error).message, progress: null, detail: null });
    });
}
