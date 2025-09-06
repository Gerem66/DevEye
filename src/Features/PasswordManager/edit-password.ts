import type { ResultSetHeader } from 'mysql2';
import type { IFeature } from '@/Interfaces/IFeature';

export const EditPassword: IFeature<'edit-password'> = async ({ db, crypt, profile, data }) => {
    const { workspaceID, password } = data;

    if (profile.user === null) {
        return {
            status: 'error'
        };
    }

    const content = crypt.Encrypt(
        JSON.stringify({
            category: password.category,
            service: password.service,
            email: password.email,
            password: password.password,
            status: password.status
        })
    );

    let result = null;
    if (workspaceID === 0) {
        const command = 'UPDATE _Passwords SET `Content` = ? WHERE `ID` = ? AND `UserID` = ? AND `WorkspaceID` IS NULL';
        const args = [content, password.ID, profile.user.ID];
        result = await db.sql.QueryPrepare<ResultSetHeader>(command, args);
    } else {
        const command = 'UPDATE _Passwords SET `Content` = ? WHERE `ID` = ? AND `UserID` = ? AND `WorkspaceID` = ?';
        const args = [content, password.ID, profile.user.ID, workspaceID];
        result = await db.sql.QueryPrepare<ResultSetHeader>(command, args);
    }

    if (result === null || result.affectedRows === 0) {
        return {
            status: 'error'
        };
    }

    return {
        status: 'success',
        password: {
            ID: password.ID,
            category: password.category,
            service: password.service,
            email: password.email,
            password: '**********',
            status: password.status
        }
    };
};
