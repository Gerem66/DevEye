import { agentManifestSchema, type AgentManifest } from 'deveye-types';

/**
 * The agent binaries' upstream source — the **only** place in the server that
 * talks to an external resource. Everything else reads from the local
 * `AGENT_DIST_DIR`. This isolation is deliberate: migrating off GitHub (to S3,
 * an internal registry, …) means swapping this module, nothing else.
 *
 * It is used solely by the boot-time reconciler; at runtime, downloads are
 * served from disk and never touch this.
 */
export interface AgentSource {
    /** The published manifest, or `null` when unavailable (no release / offline). */
    fetchManifest(): Promise<AgentManifest | null>;
    /** Raw bytes of one asset (the reconciler verifies the sha before writing). */
    fetchBinary(filename: string): Promise<Buffer>;
}

interface GithubAgentSourceOptions {
    /** `owner/repo`. */
    repo: string;
    /** Release tag holding the rolling agent build (e.g. `agent-latest`), or `latest`. */
    tag: string;
    /** Token with `contents:read` on the repo (private). */
    token: string;
    /** Optional override of the GitHub API base (tests). */
    apiBase?: string;
}

interface ReleaseAsset {
    id: number;
    name: string;
}

/** GitHub Releases implementation of {@link AgentSource}. */
export function createGithubAgentSource({
    repo,
    tag,
    token,
    apiBase = 'https://api.github.com'
}: GithubAgentSourceOptions): AgentSource {
    const releasesUrl = `${apiBase}/repos/${repo}/releases`;
    const jsonHeaders = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'deveye-server',
        'X-GitHub-Api-Version': '2022-11-28'
    };

    async function resolveAssets(): Promise<ReleaseAsset[] | null> {
        const url = tag === 'latest' ? `${releasesUrl}/latest` : `${releasesUrl}/tags/${encodeURIComponent(tag)}`;
        const res = await fetch(url, { headers: jsonHeaders });
        if (!res.ok) return null;
        const body = (await res.json()) as { assets?: ReleaseAsset[] };
        return body.assets ?? [];
    }

    async function fetchAssetBytes(asset: ReleaseAsset): Promise<Buffer> {
        const res = await fetch(`${releasesUrl}/assets/${asset.id}`, {
            headers: { ...jsonHeaders, Accept: 'application/octet-stream' }
        });
        if (!res.ok) throw new Error(`download ${asset.name}: HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }

    return {
        async fetchManifest() {
            const assets = await resolveAssets();
            if (!assets) return null;
            const manifest = assets.find((a) => a.name === 'manifest.json');
            if (!manifest) return null;
            try {
                const bytes = await fetchAssetBytes(manifest);
                const parsed = agentManifestSchema.safeParse(JSON.parse(bytes.toString('utf-8')));
                return parsed.success ? parsed.data : null;
            } catch {
                return null;
            }
        },
        async fetchBinary(filename) {
            const assets = await resolveAssets();
            const asset = assets?.find((a) => a.name === filename);
            if (!asset) throw new Error(`asset not found: ${filename}`);
            return fetchAssetBytes(asset);
        }
    };
}
