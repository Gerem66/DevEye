import { Unlock } from '@/Features/Utils/unlock';
import GLogs from '@/Utils/Logs';
import { StrIsJson } from '@/Utils/Types';

import type { IFeature } from '@/Interfaces/IFeature';
import type { PasswordDatabaseType } from 'deveye-types';

export const GetPassword: IFeature<'get-password'> = async ({ db, crypt, profile, data }) => {
    const { workspaceID, passwordID } = data;

    if (profile.user === null) {
        return {
            status: 'error'
        };
    }

    const unlockStatus = await Unlock(db, profile, workspaceID);

    if (unlockStatus === 'wrong-user' || unlockStatus === 'wrong-password') {
        return {
            status: 'unlock-failed'
        };
    } else if (unlockStatus === 'error') {
        return {
            status: 'error'
        };
    } else if (unlockStatus !== 'unlocked') {
        GLogs.warn('[get-password] Unknown unlock status:', unlockStatus);
        return {
            status: 'error'
        };
    }

    let resultPassword: PasswordDatabaseType[] | null = null;

    if (workspaceID === 0) {
        resultPassword = await db.sql.QueryPrepare<PasswordDatabaseType[]>(
            'SELECT * FROM _Passwords WHERE ID = ? AND UserID = ? AND WorkspaceID IS NULL',
            [passwordID, profile.user?.ID]
        );
    } else {
        resultPassword = await db.sql.QueryPrepare<PasswordDatabaseType[]>(
            'SELECT * FROM _Passwords WHERE ID = ? AND WorkspaceID = ?',
            [passwordID, workspaceID]
        );
    }

    if (resultPassword === null || resultPassword.length === 0) {
        GLogs.error('[get-password] Password not found:', { workspaceID, passwordID });
        return {
            status: 'unlock-failed'
        };
    }

    const rawContent = crypt.Decrypt(resultPassword[0].Content);
    if (!rawContent || !StrIsJson(rawContent)) {
        GLogs.error('[get-password] Error: Password content is not valid', { rawContent });
        return {
            status: 'error'
        };
    }

    const content = JSON.parse(rawContent);
    if (
        !Object.prototype.hasOwnProperty.call(content, 'service') ||
        !Object.prototype.hasOwnProperty.call(content, 'category') ||
        !Object.prototype.hasOwnProperty.call(content, 'email') ||
        !Object.prototype.hasOwnProperty.call(content, 'password') ||
        !Object.prototype.hasOwnProperty.call(content, 'status')
    ) {
        GLogs.error('[get-password] Error: Password content is not valid2');
        return {
            status: 'error'
        };
    }

    return {
        status: 'success',
        password: {
            ID: resultPassword[0].ID,
            category: content.category,
            service: content.service,
            email: content.email,
            password: content.password,
            status: content.status
        }
    };
};
