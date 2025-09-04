import type { ResultSetHeader } from 'mysql2';
import type { IFeature } from '@/Interfaces/IFeature';

export const DeletePassword: IFeature<'delete-password'> = async ({ db, profile, data }) => {
    const { contextID, passwordID } = data;

    if (profile.user === null) {
        console.error('[delete-password] DeletePassword: No user in profile');
        return {
            status: 'error'
        };
    }

    let result = null;

    if (contextID === 0) {
        result = await db.QueryPrepare<ResultSetHeader>(
            'DELETE FROM _Passwords WHERE `ID` = ? AND `UserID` = ? AND `ContextID` IS NULL',
            [passwordID, profile.user?.ID]
        );
    } else {
        result = await db.QueryPrepare<ResultSetHeader>(
            'DELETE FROM _Passwords WHERE `ID` = ? AND `UserID` = ? AND `ContextID` = ?',
            [passwordID, profile.user?.ID, contextID]
        );
    }

    if (result === null || result.affectedRows === 0) {
        return {
            status: 'error'
        };
    }

    return {
        status: 'success'
    };
};
