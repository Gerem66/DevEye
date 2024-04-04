/**
 * @typedef {import('./types.js').RequestTypes} RequestTypes
 */

/**
 * @template {RequestTypes} T
 * @typedef {import('./types.js').TCPFeatureType<T>} TCPFeatureType
 */

/** @type {TCPFeatureType<'add-context'>} */
async function AddContext({ db, profile, data }) {
    const { contextName } = data;

    if (profile.user === null) {
        return {
            status: 1,
            context: null
        };
    }

    const result = await db.QueryPrepare(
        'INSERT INTO Contexts SET `Name` = ?',
        [ contextName ]
    );

    if (result === null) {
        return {
            status: 2,
            context: null
        };
    }

    const context = await db.QueryPrepare(
        'SELECT * FROM Contexts WHERE `ID` = ?',
        [ result.insertId ]
    );
    if (context === null || context.length === 0) {
        return {
            status: 3,
            context: null
        };
    }

    const resultLink = await db.QueryPrepare(
        'INSERT INTO ContextsLinks SET `UserID` = ?, `ContextID` = ?',
        [ profile.user.ID, context[0].ID ]
    );

    if (resultLink === null) {
        return {
            status: 4,
            context: null
        };
    }

    return {
        status: 0,
        context: {
            id: context[0].ID,
            name: context[0].Name,
            logo: context[0].Logo,
            features: JSON.parse(context[0].Features)
        }
    };
}

/** @type {TCPFeatureType<'delete-context'>} */
async function DeleteContext({ db, crypt, profile, data }) {
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
        const result = await db.QueryPrepare(deleteCommands[i], [ contextID ]);
        if (result === null) {
            return {
                status: 2 + i
            };
        }
    }

    return {
        status: 0
    }
}

export { AddContext, DeleteContext };
