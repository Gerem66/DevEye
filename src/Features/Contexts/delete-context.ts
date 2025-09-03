import type { IFeature } from '@/Interfaces/IFeature';

export const DeleteContext: IFeature<'delete-context'> = async ({ db, profile, data }) => {
    const { contextID } = data;

    if (profile.user === null) {
        return {
            status: 1
        };
    }

    const deleteCommands = [
        'DELETE FROM _Mails WHERE `ContextID` = ?',
        'DELETE FROM _Notes WHERE `ContextID` = ?',
        'DELETE FROM _Passwords WHERE `ContextID` = ?',
        'DELETE FROM ContextsLinks WHERE `ContextID` = ?',
        'DELETE FROM Contexts WHERE `ID` = ?'
    ];

    for (let i = 0; i < deleteCommands.length; i++) {
        const result = await db.QueryPrepare(deleteCommands[i], [contextID]);
        if (result === null) {
            return {
                status: 2 + i
            };
        }
    }

    return {
        status: 0
    };
};
