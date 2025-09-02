import { ResultSetHeader } from 'mysql2';

import type { TCPFeatureType } from './types.js';

export const SetFavorite: TCPFeatureType<'set-favorite-context'> = async ({ db, profile, data }) => {
    const { contextID, featureID } = data;
    const { user } = profile;

    if (user === null) {
        return {
            status: 1
        };
    }

    const result = await db.QueryPrepare<ResultSetHeader>(
        'UPDATE Users SET DefaultContext = ?, DefaultFeature = ? WHERE ID = ?',
        [contextID, featureID, user.ID]
    );
    if (result === null || result.affectedRows === 0) {
        return {
            status: 2
        };
    }

    return {
        status: 0
    };
};
