import type { Database } from '@/db';
import type { HomeLayout, MinimalUser, SessionBundle, ThemeStateDTO, UserRole, Workspace } from '@deveye/types';
import { homeLayoutSchema, themeStateSchema } from '@deveye/types';
import { toRemoteInstance } from '@/db/repos/remoteInstances';
import { permissionsFor } from '@/features/_access';
import { maintenance, MaintenanceError } from '@/Services/maintenance';
import { env } from '@/Utils/Env';

/**
 * Charge tout ce qu'une session a besoin de connaître : le compte, ses espaces,
 * et le seul espace actif avec son thème et sa disposition d'accueil. Le thème
 * des autres espaces n'est pas embarqué (`bgImages` peut peser lourd).
 */
export async function loadUserBundle(
    db: Database,
    userId: number,
    /**
     * Espace où le client se trouve déjà : sans lui, le serveur renverrait thème,
     * disposition et droits d'un autre espace que celui affiché. Ignoré s'il
     * n'est plus accessible.
     */
    preferredWorkspaceId?: number
): Promise<SessionBundle | null> {
    const row = await db.users.findById(userId);
    if (!row) return null;
    // Un compte suspendu n'a pas de session : `/me` et `/refresh` passent ici,
    // et le jeton d'accès déjà émis reste valide jusqu'à son expiration.
    if (row.status === 'suspended') return null;
    const isAdmin = row.role === 'admin';
    // Même passage obligé : pendant la maintenance du site, seul l'administrateur
    // obtient une session.
    if (maintenance.siteDown() && !isAdmin) throw new MaintenanceError(maintenance.message());

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
        const userIds = new Set(memberRows.filter((m) => m.workspace_id === w.id).map((m) => m.user_id));
        const users: MinimalUser[] = memberUserRows
            .filter((u) => userIds.has(u.id))
            .map((u) => ({
                id: u.id,
                email: u.email,
                username: u.username,
                avatar: u.avatar,
                color: u.color,
                lastLogin: Number(u.last_login),
                created: Number(u.created)
            }));
        return {
            id: w.id,
            kind: w.kind,
            name: w.name,
            logo: w.logo,
            ownerUserId: w.owner_user_id,
            users,
            features: parseStringArray(w.features),
            created: Number(w.created)
        };
    });

    // Par préséance : l'espace où le client se trouve déjà, sinon son favori,
    // sinon le personnel ; chacun seulement s'il est encore accessible.
    const accessible = new Set(workspaces.map((w) => w.id));
    const activeWorkspaceId =
        [preferredWorkspaceId, row.default_workspace_id].find((id): id is number => id != null && accessible.has(id)) ??
        // L'espace personnel est accessible par construction ; si cet invariant
        // cassait, échouer ici serait pire qu'ouvrir un espace vide.
        row.personal_workspace_id;

    const activeRow = await db.workspaces.findById(activeWorkspaceId);
    const remoteRows = await db.remoteInstances.listByUser(userId);

    return {
        user: {
            id: row.id,
            email: row.email,
            username: row.username,
            avatar: row.avatar,
            color: row.color,
            role: (isAdmin ? 'admin' : 'user') as UserRole,
            settings: parseStringArray(row.settings),
            security,
            personalWorkspaceId: row.personal_workspace_id,
            defaultWorkspaceId: row.default_workspace_id,
            lastLogin: Number(row.last_login),
            created: Number(row.created)
        },
        workspaces,
        remoteInstances: remoteRows.map(toRemoteInstance),
        activeWorkspaceId,
        theme: parseTheme(activeRow?.theme),
        homeLayout: parseHomeLayout(activeRow?.home_layout),
        permissions: activeRow
            ? await permissionsFor(db, userId, activeRow)
            : { isOwner: false, capabilities: [], features: [], itemOverrides: [] },
        feedbackEnabled: env.FEEDBACK_ENABLED,
        maintenanceEnvNotice: isAdmin && (await maintenance.envNotice())
    };
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

function parseHomeLayout(raw: string | null | undefined): HomeLayout | null {
    if (!raw) return null;
    try {
        const parsed = homeLayoutSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * Une colonne `JSON` tenant un tableau de chaînes : selon la configuration du
 * pool, mysql2 rend la valeur désérialisée ou la chaîne brute. Tout le reste
 * vaut « rien », une colonne illisible ne doit pas faire échouer une session.
 */
export function parseStringArray(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return [];
}
