import type { ResultSetHeader } from 'mysql2';
import type { DBContextType } from 'deveye-types';
import type { IFeature } from '@/Interfaces/IFeature';

export const AddContext: IFeature<'add-context'> = async ({ db, profile, data }) => {
    const { contextName } = data;

    if (profile.user === null) {
        return {
            status: 'error'
        };
    }

    const result = await db.QueryPrepare<ResultSetHeader>('INSERT INTO Contexts SET `Name` = ?', [contextName]);

    if (result === null) {
        return {
            status: 'error'
        };
    }

    const context = await db.QueryPrepare<DBContextType[]>('SELECT * FROM Contexts WHERE `ID` = ?', [result.insertId]);
    if (context === null || context.length === 0) {
        return {
            status: 'error'
        };
    }

    const resultLink = await db.QueryPrepare('INSERT INTO ContextsLinks SET `UserID` = ?, `ContextID` = ?', [
        profile.user.ID,
        context[0].ID
    ]);

    if (resultLink === null) {
        return {
            status: 'error'
        };
    }

    return {
        status: 'success',
        context: {
            id: context[0].ID,
            name: context[0].Name,
            logo: context[0].Logo,
            users: [
                {
                    ID: profile.user.ID,
                    Username: profile.user.Username,
                    Email: profile.user.Email,
                    Avatar: profile.user.Avatar,
                    Created: profile.user.Created
                }
            ],
            features: JSON.parse(context[0].Features),
            reAuthInterval: context[0].ReAuthInterval,
            created: context[0].Created
        }
    };
};
