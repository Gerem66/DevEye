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

async function finalize(
    distDir: string,
    manifest: AgentManifest | null,
    errors: string[],
    want: string
): Promise<void> {
    const present = await Promise.all(AGENT_TARGETS.map((t) => fileExists(join(distDir, t.filename))));
    const available = present.filter(Boolean).length;
    if (available === 0) {
        status.update(TASK_ID, {
            state: 'error',
            progress: null,
            detail: null,
            error: errors.length ? errors.join(' · ') : 'Aucun binaire disponible'
        });
        return;
    }
    // A usable set is present (maybe an older version than `want`, or a target or
    // two short): "ready" for serving. Per-target gaps and version mismatches are
    // surfaced in the download popup, not held against the whole app's readiness.
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
 * only the changed binaries; if the build for *this* deploy's version isn't
 * published yet, it keeps a usable set and retries until `want` lands or the cap
 * is hit — then stops for good. No steady-state polling.
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
                if (manifest.version === want) return finalize(distDir, manifest, [], want);
            }
        }
        if (Date.now() >= deadline) return finalize(distDir, await readSyncedManifest(distDir), lastErrors, want);
        status.update(TASK_ID, {
            state: 'running',
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
