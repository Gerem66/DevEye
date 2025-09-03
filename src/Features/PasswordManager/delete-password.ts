import type { IFeature } from '@/Interfaces/IFeature';

export const DeletePassword: IFeature<'delete-password'> = async ({ db, profile, data }) => {
    const { contextID, passwordID } = data;

    let result = null;

    if (contextID === 0) {
        result = await db.QueryPrepare(
            'DELETE FROM _Passwords WHERE `ID` = ? AND `UserID` = ? AND `ContextID` IS NULL',
            [passwordID, profile.user?.ID]
        );
    } else {
        result = await db.QueryPrepare('DELETE FROM _Passwords WHERE `ID` = ? AND `UserID` = ? AND `ContextID` = ?', [
            passwordID,
            profile.user?.ID,
            contextID
        ]);
    }

    if (result === null) {
        return {
            status: 1
        };
    }

    return {
        status: 0
    };
};
