import GLogs from '@/Utils/Logs';

import type { ResultSetHeader } from 'mysql2';
import type { IFeature } from '@/Interfaces/IFeature';

export const DeleteContext: IFeature<'delete-context'> = async ({ db, profile, data }) => {
    const { contextID } = data;

    if (profile.user === null) {
        return {
            status: 'error'
        };
    }

    // TODO: One transaction for all these queries?
    const deleteCommands = [
        'DELETE FROM _Mails WHERE `ContextID` = ?',
        'DELETE FROM _Notes WHERE `ContextID` = ?',
        'DELETE FROM _Passwords WHERE `ContextID` = ?',
        'DELETE FROM ContextsLinks WHERE `ContextID` = ?',
        'DELETE FROM Contexts WHERE `ID` = ?'
    ];

    for (let i = 0; i < deleteCommands.length; i++) {
        try {
            await db.QueryPrepare<ResultSetHeader>(deleteCommands[i], [contextID]);
        } catch (error) {
            GLogs.error(`[delete-context] Error executing command: ${deleteCommands[i]}`, { error });
            return {
                status: 'error'
            };
        }
    }

    return {
        status: 'success'
    };
};
