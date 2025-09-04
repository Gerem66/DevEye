import GLogs from '@/Utils/Logs.js';

import type { ResultSetHeader } from 'mysql2';
import type { IFeature } from '../../Interfaces/IFeature.js';

export const SetFavorite: IFeature<'set-favorite-context'> = async ({ db, profile, data }) => {
    const { contextID, featureID } = data;
    const { user } = profile;

    if (user === null) {
        return {
            status: 'error'
        };
    }

    const result = await db.QueryPrepare<ResultSetHeader>(
        'UPDATE Users SET DefaultContext = ?, DefaultFeature = ? WHERE ID = ?',
        [contextID, featureID, user.ID]
    );
    if (result === null || result.affectedRows === 0) {
        GLogs.error(`[set-favorite-context] Failed to set favorite context/feature for user ID ${user.ID}`);
        return {
            status: 'error'
        };
    }

    return {
        status: 'success'
    };
};
