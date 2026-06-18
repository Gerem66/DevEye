import type { Database } from '@/db';
import type { MinimalUser, ThemeStateDTO, User, UserRole, Workspace } from 'deveye-types';
import { themeStateSchema } from 'deveye-types';

export async function loadUserBundle(
    db: Database,
    userId: number
): Promise<{ user: User; workspaces: Workspace[] } | null> {
    const row = await db.users.findById(userId);
    if (!row) return null;

    // Security posture surfaced as "Sécurité → x / 3" in the profile. The
    // re-auth window counts when strict — short enough (≤ 5 min) to be a
    // meaningful protection, 0 being the strongest setting (always re-prompt).
    // A null interval falls back to the 60s server default, which is strict.
    const [twoFaRow, secretKeyRow] = await Promise.all([db.twoFactor.get(userId), db.userSecretKeys.get(userId)]);
    const reAuth = row.re_auth_interval ?? 60;
    const security = {
        twoFactor: Boolean(twoFaRow?.enabled),
        passwordEncryption: secretKeyRow?.wrap_mode === 'password',
        reAuthValidation: reAuth <= 300
    };

    const wsRows = await db.workspaces.findAccessibleByUser(userId);
    const memberRows = wsRows.length ? await db.workspaceMembers.listByWorkspaceIds(wsRows.map((w) => w.id)) : [];

    const memberIds = Array.from(new Set(memberRows.map((m) => m.user_id)));
    const memberUserRows = memberIds.length ? await db.users.findByIds(memberIds) : [];

    const workspaces: Workspace[] = wsRows.map((w) => {
        const userIds = memberRows.filter((m) => m.workspace_id === w.id).map((m) => m.user_id);
        const users: MinimalUser[] = memberUserRows
            .filter((u) => userIds.includes(u.id))
            .map((u) => ({
                id: u.id,
                email: u.email,
                username: u.username,
                avatar: u.avatar,
                created: Number(u.created)
            }));
        return {
            id: w.id,
            name: w.name,
            logo: w.logo,
            users,
            features: parseStringArray(w.features),
            reAuthInterval: w.re_auth_interval,
            created: Number(w.created)
        };
    });

    // Personal/private workspace (id 0). Not a row in `workspaces`: it belongs to
    // the user alone, its features live on `users.features`, and its items use
    // `workspace_id = NULL`. Always surfaced first.
    const personalWorkspace: Workspace = {
        id: 0,
        name: row.username,
        logo: 'default-workspace.png',
        users: [
            {
                id: row.id,
                email: row.email,
                username: row.username,
                avatar: row.avatar,
                created: Number(row.created)
            }
        ],
        features: parseStringArray(row.features),
        reAuthInterval: null,
        created: Number(row.created)
    };

    const user: User = {
        id: row.id,
        email: row.email,
        username: row.username,
        avatar: row.avatar,
        role: (row.role === 'admin' ? 'admin' : 'user') as UserRole,
        settings: parseStringArray(row.settings),
        security,
        defaultWorkspace: row.default_workspace,
        lastLogin: Number(row.last_login),
        created: Number(row.created),
        theme: parseTheme(row.theme)
    };

    return { user, workspaces: [personalWorkspace, ...workspaces] };
}

function parseTheme(raw: string | null | undefined): ThemeStateDTO | null {
    if (!raw) return null;
    try {
        const parsed = themeStateSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function parseStringArray(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return [];
}
