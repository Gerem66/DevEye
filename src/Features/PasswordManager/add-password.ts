import type { ResultSetHeader } from 'mysql2';
import type { IFeature } from '@/Interfaces/IFeature';

export const AddPassword: IFeature<'add-password'> = async ({ db, crypt, profile, data }) => {
    const { contextID, password } = data;

    if (profile.user === null) {
        return {
            status: 'error'
        };
    }

    const newPassword = {
        UserID: profile.user.ID,
        ContextID: contextID || null,
        Content: crypt.Encrypt(
            JSON.stringify({
                category: password.category,
                service: password.service,
                email: password.email,
                password: password.password,
                status: password.status
            })
        )
    };

    let result = null;

    if (contextID === 0) {
        result = await db.QueryPrepare<ResultSetHeader>(
            'INSERT INTO _Passwords SET `UserID` = ?, `ContextID` = NULL, `Content` = ?',
            [newPassword.UserID, newPassword.Content]
        );
    } else {
        result = await db.QueryPrepare<ResultSetHeader>(
            'INSERT INTO _Passwords SET `UserID` = ?, `ContextID` = ?, `Content` = ?',
            [newPassword.UserID, newPassword.ContextID, newPassword.Content]
        );
    }

    if (result === null) {
        return {
            status: 'error'
        };
    }

    return {
        status: 'success',
        password: {
            ID: result.insertId,
            category: password.category,
            service: password.service,
            email: password.email,
            password: '**********',
            status: password.status
        }
    };
};
