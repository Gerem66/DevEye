import type { IFeature } from '@/Interfaces/IFeature';

export const AddWorkspace: IFeature<'add-workspace'> = async ({ db, profile, data }) => {
    const { workspaceName } = data;

    if (profile.user === null) {
        throw new Error('User not logged in');
    }

    const workspaceId = await db.workspaces.Create(workspaceName);
    const workspaces = await db.workspaces.Get({ ID: workspaceId });

    if (workspaces.length === 0) {
        throw new Error('Failed to get the created workspace');
    }

    const workspace = workspaces[0];

    const linkId = await db.workspaceMembers.Create({
        UserID: profile.user.ID,
        WorkspaceID: workspaces[0].ID,
        Roles: '[]'
    });

    return {
        status: 'success',
        workspace: {
            id: workspace.ID,
            name: workspace.Name,
            logo: workspace.Logo,
            users: [
                {
                    ID: profile.user.ID,
                    Username: profile.user.Username,
                    Email: profile.user.Email,
                    Avatar: profile.user.Avatar,
                    Created: profile.user.Created
                }
            ],
            features: JSON.parse(workspace.Features),
            reAuthInterval: workspace.ReAuthInterval,
            created: workspace.Created
        }
    };
};
