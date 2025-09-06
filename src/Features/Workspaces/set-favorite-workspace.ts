import GLogs from '@/Utils/Logs.js';

import type { IFeature } from '../../Interfaces/IFeature.js';

export const SetFavoriteWorkspace: IFeature<'set-favorite-workspace'> = async ({ db: database, profile, data }) => {
    const { workspaceID, featureID } = data;
    const { user } = profile;

    if (user === null) {
        return {
            status: 'error'
        };
    }

    const success = await database.users!.Update(user.ID, {
        DefaultWorkspace: workspaceID,
        DefaultFeature: featureID
    });

    if (!success) {
        GLogs.error(`[set-favorite-workspace] Failed to set favorite workspace/feature for user ID ${user.ID}`);
        return {
            status: 'error'
        };
    }

    return {
        status: 'success'
    };
};
