import GLogs from '@/Utils/Logs';

import type { IFeature } from '@/Interfaces/IFeature';

export const DeleteWorkspace: IFeature<'delete-workspace'> = async ({ db: database, profile, data }) => {
    const { workspaceID } = data;

    if (profile.user === null) {
        return {
            status: 'error'
        };
    }

    try {
        // TODO: One transaction for all these queries?

        // Delete related data (custom tables like _Mails, _Notes, _Passwords need to be handled separately as they're not in our main tables)
        await database.sql.QueryPrepare('DELETE FROM _Mails WHERE `WorkspaceID` = ?', [workspaceID]);
        await database.sql.QueryPrepare('DELETE FROM _Notes WHERE `WorkspaceID` = ?', [workspaceID]);
        await database.sql.QueryPrepare('DELETE FROM _Passwords WHERE `WorkspaceID` = ?', [workspaceID]);

        // Delete workspace links
        await database.workspaceMembers!.DeleteByWorkspaceID(workspaceID);

        // Delete workspace
        const success = await database.workspaces!.Delete(workspaceID);

        if (!success) {
            throw new Error('Failed to delete workspace');
        }
    } catch (error) {
        GLogs.error('[delete-workspace] Error deleting workspace', { error, workspaceID });
        return {
            status: 'error'
        };
    }

    return {
        status: 'success'
    };
};
