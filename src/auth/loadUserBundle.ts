import type { Database } from '@/db';
import type { HomeLayout, MinimalUser, SessionBundle, ThemeStateDTO, Workspace } from '@deveye/types';
import {
    homeLayoutSchema,
    STEP_UP_MINUTES_DEFAULT,
    STEP_UP_STRICT_MINUTES,
    themeStateSchema,
    TRUSTED_BROWSERS_MAX
} from '@deveye/types';
import { toRemoteInstance } from '@/db/repos/remoteInstances';
import { roleOf } from '@/db/repos/users';
import { permissionsFor } from '@/features/_access';
import { ORIGINS } from '@/features/_sdk/context';
import { maintenance, MaintenanceError } from '@/Services/maintenance';
import { memberPausedIn, workspacePauses } from '@/Services/planPauses';
import { serverMail } from '@/Services/serverMail';
import { sms } from '@/Services/sms';
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
    const role = roleOf(row.role);
    const isAdmin = role === 'admin';
    // Même passage obligé : pendant la maintenance du site, seul l'administrateur
    // obtient une session.
    if (maintenance.siteDown() && !isAdmin) throw new MaintenanceError(maintenance.message());

    // Le niveau de sécurité, « Sécurité x / y » dans le Profil et les boucliers
    // de la page Sécurité. Un délai ne compte qu'avec la protection qu'il
    // précise : la validation du mot de passe (5 min ou moins, 0 le plus fort,
    // null valant la minute par défaut) avec le chiffrement, le pilotage des
    // machines avec la double authentification, les navigateurs de confiance
    // (pas plus de TRUSTED_BROWSERS_MAX) avec la confirmation des connexions.
    const now = Math.floor(Date.now() / 1000);
    const [twoFaRow, secretKeyRow, phoneRow, browsers] = await Promise.all([
        db.twoFactor.get(userId),
        db.userSecretKeys.get(userId),
        db.userPhones.get(userId),
        db.trustedBrowsers.listByUser(userId, now)
    ]);
    const reAuth = row.re_auth_interval ?? 60;
    const stepUpMinutes = Math.round((row.step_up_interval ?? STEP_UP_MINUTES_DEFAULT * 60) / 60);
    // Sans mail ni SMS, la confirmation des connexions n'existe pas ici : elle ne compte pas.
    const confirms = serverMail.configured || sms.available;
    const loginConfirmation = confirms
        ? (serverMail.configured && row.login_email_check === 1) || (sms.available && phoneRow?.sms_check === 1)
        : null;
    const twoFactor = Boolean(twoFaRow?.enabled);
    const passwordEncryption = secretKeyRow?.wrap_mode === 'password';
    const security = {
        loginConfirmation,
        trustedBrowsers:
            loginConfirmation === null ? null : loginConfirmation && browsers.length <= TRUSTED_BROWSERS_MAX,
        twoFactor,
        stepUpValidation: twoFactor && stepUpMinutes <= STEP_UP_STRICT_MINUTES,
        passwordEncryption,
        reAuthValidation: passwordEncryption && reAuth <= 300
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
                lastSeen: Number(u.last_seen),
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
            created: Number(w.created),
            ...workspacePauses(w.id, [...userIds])
        };
    });

    // Par préséance : l'espace où le client se trouve déjà, sinon son favori,
    // sinon le personnel ; chacun seulement s'il est encore accessible. Un
    // espace où l'offre de son propriétaire le tient en pause ne l'est pas.
    const accessible = new Set(
        workspaces.filter((w) => w.ownerUserId === userId || !memberPausedIn(w.id, userId)).map((w) => w.id)
    );
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
            role,
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
        siteUrl: ORIGINS.site,
        sourceUrl: env.SOURCE_URL || null,
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
