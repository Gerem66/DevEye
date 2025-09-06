import GLogs from '@/Utils/Logs';

import type { IFeature } from '@/Interfaces/IFeature';

export const DeleteWorkspace: IFeature<'delete-workspace'> = async ({ db, profile, data }) => {
    const { workspaceID } = data;

    if (profile.user === null) {
        return {
            status: 'error'
        };
    }

    try {
        // TODO: One transaction for all these queries?

        // Delete related data (custom tables like _Mails, _Notes, _Passwords need to be handled separately as they're not in our main tables)
        await db.sql.QueryPrepare('DELETE FROM _Mails WHERE `WorkspaceID` = ?', [workspaceID]);
        await db.sql.QueryPrepare('DELETE FROM _Notes WHERE `WorkspaceID` = ?', [workspaceID]);
        await db.sql.QueryPrepare('DELETE FROM _Passwords WHERE `WorkspaceID` = ?', [workspaceID]);

        // Delete workspace links
        await db.workspaceMembers.Delete({ ID: workspaceID });

        // Delete workspace
        const success = await db.workspaces.Delete(workspaceID);

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
