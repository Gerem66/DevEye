import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { AGENT_TARGETS, agentManifestSchema, type AgentManifest } from '@deveye/types';

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
 * Settle the reconcile task on its terminal verdict — never an endless spinner:
 *  - serving exactly `want` (maybe a target or two short) → `done` (zone hides);
 *  - serving an OLDER/unknown set because `want` never published (slow or failed
 *    build) → `warning` (zone stays, amber, non-blocking — the app runs on the
 *    served agents but the operator sees this deploy didn't get its version);
 *  - nothing to serve at all (first deploy + a failed build) → `error`.
 * Per-target download errors ride along in the `error` field regardless of state.
 *
 * `note` qualifies *why* we're settling — it is appended to every detail, so the
 * "sync is off" case reads as a served-set verdict rather than as a build verdict.
 */
async function settle(distDir: string, errors: string[], want: string, note?: string): Promise<void> {
    const available = await presentCount(distDir);
    const errorDetail = errors.length ? errors.join(' · ') : null;
    const qualify = (detail: string): string => (note ? `${detail} · ${note}` : detail);

    if (available === 0) {
        status.update(TASK_ID, {
            state: 'error',
            progress: null,
            detail: null,
            error: errorDetail ?? qualify(`Build des agents indisponible (version ${want})`)
        });
        return;
    }

    const version = (await readSyncedManifest(distDir))?.version ?? null;
    if (version === want) {
        status.update(TASK_ID, {
            state: 'done',
            progress: 1,
            detail: qualify(`Version ${version}`),
            error: errorDetail
        });
        return;
    }

    status.update(TASK_ID, {
        state: 'warning',
        progress: null,
        detail: qualify(
            version
                ? `Agents en v${version} — build v${want} indisponible`
                : `Build v${want} indisponible (${available}/${AGENT_TARGETS.length} binaires)`
        ),
        error: errorDetail
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
 * only the changed binaries; while *this* deploy's version isn't published yet it
 * shows a loader and retries, until `want` lands or `maxWaitMs` is hit — then it
 * always settles on a terminal verdict via {@link settle} (done / warning / error),
 * never an endless spinner. The wait is the only signal we have to tell a slow
 * build from a failed one, so it's tunable (`AGENT_SYNC_TIMEOUT_SECONDS`). No
 * steady-state polling.
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
                // Got exactly what this deploy wants → settle `done` (zone hides).
                if (manifest.version === want) return settle(distDir, [], want);
            }
        }
        // Time's up: settle on whatever we have (older set ⇒ warning, nothing ⇒ error).
        if (Date.now() >= deadline) return settle(distDir, lastErrors, want);
        // Back to waiting (build not published yet, or no manifest): drop the bar
        // so it's loader-only. `status.update` patches, so progress would
        // otherwise stay stuck at the last value set during downloadDiffs.
        status.update(TASK_ID, {
            state: 'running',
            progress: null,
            detail: manifest ? `En attente de la version ${want}…` : 'Manifeste indisponible, nouvel essai…'
        });
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

    const token = env.AGENT_DOWNLOAD_TOKEN || '';
    const repo = env.AGENT_REPO || '';
    if (!token || !repo) {
        // No upstream configured (no token, or AGENT_REPO unset): serve disk only.
        // Still *judge* that disk against this deploy's version instead of
        // reporting `done` outright — a disabled sync freezes the served set
        // forever, and announcing it green is how a server ended up handing out
        // two-versions-old agents (and their dead protocol) without a warning.
        void settle(distDir, [], appVersion(), 'synchronisation désactivée').catch((e) => {
            logger.error({ err: (e as Error).message }, 'Agent settle (sync disabled) failed');
        });
        return;
    }

    const source = createGithubAgentSource({
        repo,
        tag: env.AGENT_RELEASE_TAG || 'agent-latest',
        token
    });

    const maxWaitMs = env.AGENT_SYNC_TIMEOUT_SECONDS * 1000;
    void reconcileAgents({ source, distDir, want: appVersion(), maxWaitMs, pollMs: 20_000 }).catch((e) => {
        logger.error({ err: (e as Error).message }, 'Agent reconcile crashed');
        status.update(TASK_ID, { state: 'error', error: (e as Error).message, progress: null, detail: null });
    });
}
