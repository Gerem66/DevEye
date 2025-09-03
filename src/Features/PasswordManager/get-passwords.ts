import { StrIsJson } from '@/Utils/Types';

import type { IFeature } from '@/Interfaces/IFeature';
import type { PasswordType, PasswordDatabaseType } from 'deveye-types';

export const GetPasswords: IFeature<'get-passwords'> = async ({ db, crypt, profile, data }) => {
    const { contextID } = data;

    let passwords: PasswordDatabaseType[] | null = null;

    if (contextID === 0) {
        passwords = await db.QueryPrepare<PasswordDatabaseType[]>(
            'SELECT * FROM _Passwords WHERE UserID = ? AND ContextID IS NULL',
            [profile.user?.ID]
        );
    } else {
        passwords = await db.QueryPrepare<PasswordDatabaseType[]>('SELECT * FROM _Passwords WHERE ContextID = ?', [
            contextID
        ]);
    }

    if (passwords === null) {
        return {
            status: 1,
            passwords: []
        };
    }

    const passwordsFormatted = passwords
        .map((p): PasswordType | null => {
            const rawContent = crypt.Decrypt(p.Content);
            if (!rawContent || !StrIsJson(rawContent)) {
                console.log('Error: Password content is not valid', rawContent);
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
                console.log('Error: Password content is not valid2', content);
                return null;
            }

            const ID = p.ID;
            const { category, service, email, password: realPassword, status } = content;
            const password = realPassword ? '**********' : '';
            return { ID, category, service, email, password, status };
        })
        .filter((p) => p !== null);

    return {
        status: 0,
        passwords: passwordsFormatted
    };
};
