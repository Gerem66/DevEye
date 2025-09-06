import bcrypt from 'bcrypt';

import type { Database } from '@/Database';
import type { ClientSession } from '@/Interfaces/IClient';

function GetAuth(profile: ClientSession, workspaceID: number): ClientSession['authentifications'][0] | null {
    return profile.authentifications.find((a) => a.workspaceID === workspaceID) || null;
}

/**
 * @description Temporary unlock the workspace
 */
export async function Unlock(
    db: Database,
    profile: ClientSession,
    workspaceID: number,
    password: string | null = null
): Promise<'unlocked' | 'wrong-user' | 'wrong-password' | 'error'> {
    const workspace = profile.user?.Workspaces.find((c) => c.id === workspaceID) || null;
    const workspaceAuth = GetAuth(profile, workspaceID);

    // Not user
    if (profile.user === null || workspace === null) {
        return 'wrong-user';
    }

    // Already unlocked
    if (workspaceAuth !== null) {
        if (workspaceAuth.resetTimeout !== null) {
            clearTimeout(workspaceAuth.resetTimeout);
        }

        workspaceAuth.passwordResetTime = Date.now() / 1000;
        workspaceAuth.resetTimeout =
            workspace.reAuthInterval === null
                ? null
                : setTimeout(
                      () => {
                          const index = profile.authentifications.findIndex((a) => a.workspaceID === workspaceID);
                          if (index !== -1) {
                              if (profile.authentifications[index].resetTimeout !== null) {
                                  clearTimeout(profile.authentifications[index].resetTimeout);
                              }
                              profile.authentifications.splice(index, 1);
                          }
                      },
                      1000 * 60 * workspace.reAuthInterval
                  );

        return 'unlocked';
    }

    // Get target hash
    let targetHash = null;
    if (workspaceID === 0) {
        if (!profile.user?.ID) {
            return 'error';
        }
        const users = await db.users.Get({ ID: profile.user.ID });
        if (users.length === 0 || !users[0].Password) {
            return 'error';
        }
        targetHash = users[0].Password;
    } else {
        const workspaces = await db.workspaces.Get({ ID: workspaceID });
        if (workspaces.length === 0) {
            return 'error';
        }

        const workspace = workspaces[0];
        if (!workspace.Password || workspace.Password === '') {
            return 'unlocked';
        }
        targetHash = workspace.Password;
    }

    if (password === null) {
        return 'wrong-password';
    }

    let match = targetHash === null;
    if (targetHash !== null) {
        if (targetHash.startsWith('$2y$')) {
            targetHash = '$2b$' + targetHash.substring(4);
        }

        try {
            const result = await bcrypt.compareSync(password, targetHash);
            match = result;
        } catch (error) {
            console.error(error);
        }
    }

    if (!match) {
        return 'wrong-password';
    }

    // Unlock
    if (workspaceAuth === null) {
        profile.authentifications.push({
            workspaceID,
            clearPassword: password,
            passwordResetTime: Date.now() / 1000,
            resetTimeout:
                workspace.reAuthInterval === null
                    ? null
                    : setTimeout(
                          () => {
                              const index = profile.authentifications.findIndex((a) => a.workspaceID === workspaceID);
                              if (index !== -1) {
                                  if (profile.authentifications[index].resetTimeout !== null) {
                                      clearTimeout(profile.authentifications[index].resetTimeout);
                                  }
                                  profile.authentifications.splice(index, 1);
                              }
                          },
                          1000 * 60 * workspace.reAuthInterval
                      )
        });
    }

    return 'unlocked';
}
