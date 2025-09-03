import { StrIsJson } from '@/Utils/Types';
import { Unlock } from '@/Features/Utils/unlock';

import type { IFeature } from '@/Interfaces/IFeature';
import type { PasswordDatabaseType } from 'deveye-types';

export const GetPassword: IFeature<'get-password'> = async ({ db, crypt, profile, data }) => {
    const { contextID, passwordID } = data;

    const unlockStatus = await Unlock(db, profile, contextID);
    if (unlockStatus === 'error') {
        return {
            status: 1,
            password: null
        };
    }
    if (unlockStatus !== 'unlocked') {
        return {
            status: 2,
            password: null
        };
    }

    let resultPassword: PasswordDatabaseType[] | null = null;

    if (contextID === 0) {
        resultPassword = await db.QueryPrepare<PasswordDatabaseType[]>(
            'SELECT * FROM _Passwords WHERE ID = ? AND UserID = ? AND ContextID IS NULL',
            [passwordID, profile.user?.ID]
        );
    } else {
        resultPassword = await db.QueryPrepare<PasswordDatabaseType[]>(
            'SELECT * FROM _Passwords WHERE ID = ? AND ContextID = ?',
            [passwordID, contextID]
        );
    }

    if (resultPassword === null || resultPassword.length === 0) {
        console.log('Error: Password not found');
        return {
            status: 3,
            password: null
        };
    }

    const rawContent = crypt.Decrypt(resultPassword[0].Content);
    if (!rawContent || !StrIsJson(rawContent)) {
        console.log('Error: Password content is not valid', rawContent);
        return {
            status: 4,
            password: null
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
        console.log('Error: Password content is not valid2', content);
        return {
            status: 5,
            password: null
        };
    }

    return {
        status: 0,
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
