import GLogs from '@/Utils/Logs';
import { StrIsJson } from '@/Utils/Types';

import type { IFeature } from '@/Interfaces/IFeature';
import type { PasswordType, PasswordDatabaseType } from 'deveye-types';

export const GetPasswords: IFeature<'get-passwords'> = async ({ db, crypt, profile, data }) => {
    const { workspaceID } = data;

    if (profile.user === null) {
        GLogs.error('[get-passwords] No user in profile');
        return {
            status: 'error'
        };
    }

    let passwords: PasswordDatabaseType[] | null = null;

    if (workspaceID === 0) {
        passwords = await db.sql.QueryPrepare<PasswordDatabaseType[]>(
            'SELECT * FROM _Passwords WHERE UserID = ? AND WorkspaceID IS NULL',
            [profile.user?.ID]
        );
    } else {
        passwords = await db.sql.QueryPrepare<PasswordDatabaseType[]>(
            'SELECT * FROM _Passwords WHERE WorkspaceID = ?',
            [workspaceID]
        );
    }

    if (passwords === null) {
        return {
            status: 'error'
        };
    }

    const passwordsFormatted = passwords
        .map((p): PasswordType | null => {
            const rawContent = crypt.Decrypt(p.Content);
            if (!rawContent || !StrIsJson(rawContent)) {
                GLogs.error('[get-passwords] Error: Password content is not valid');
                return null;
            }

            const content = JSON.parse(rawContent);
            if (
                !Object.prototype.hasOwnProperty.call(content, 'service') ||
                !Object.prototype.hasOwnProperty.call(content, 'category') ||
                !Object.prototype.hasOwnProperty.call(content, 'email') ||
                !Object.prototype.hasOwnProperty.call(content, 'password') ||
                !Object.prototype.hasOwnProperty.call(content, 'status')
            ) {
                GLogs.error('[get-passwords] Error: Password content is not valid2', { rawContent });
                return null;
            }

            const ID = p.ID;
            const { category, service, email, password: realPassword, status } = content;
            const password = realPassword ? '**********' : '';
            return { ID, category, service, email, password, status };
        })
        .filter((p) => p !== null);

    return {
        status: 'success',
        passwords: passwordsFormatted
    };
};
