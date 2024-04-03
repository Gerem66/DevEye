/**
 * @typedef {import('./types.js').RequestTypes} RequestTypes
 */

/**
 * @template {RequestTypes} T
 * @typedef {import('./types.js').TCPFeatureType<T>} TCPFeatureType
 */

/** @type {TCPFeatureType<'add-password'>} */
async function AddPassword({ db, crypt, profile, data }) {
    const { contextID, password } = data;

    if (profile.user === null) {
        return {
            status: 1,
            password: null
        };
    }

    const newPassword = {
        UserID: profile.user.ID,
        ContextID: contextID || null,
        Content: crypt.Encrypt(JSON.stringify({
            category: password.category,
            service: password.service,
            email: password.email,
            password: password.password,
            status: password.status
        }))
    };

    let result = null;

    if (contextID === 0) {
        result = await db.QueryPrepare(
            'INSERT INTO _Passwords SET `UserID` = ?, `ContextID` = NULL, `Content` = ?',
            [ newPassword.UserID, newPassword.Content ]
        );
    } else {
        result = await db.QueryPrepare(
            'INSERT INTO _Passwords SET `UserID` = ?, `ContextID` = ?, `Content` = ?',
            [ newPassword.UserID, newPassword.ContextID, newPassword.Content ]
        );
    }

    if (result === null) {
        return {
            status: 1,
            password: null
        };
    }

    return {
        status: 0,
        password: {
            ID: result.insertId,
            category: password.category,
            service: password.service,
            email: password.email,
            password: '**********',
            status: password.status
        }
    };
}

/** @type {TCPFeatureType<'edit-password'>} */
async function EditPassword({ db, crypt, profile, data }) {
    const { contextID, password } = data;

    if (profile.user === null) {
        return {
            status: 1,
            password: null
        };
    }

    const content = crypt.Encrypt(JSON.stringify({
        category: password.category,
        service: password.service,
        email: password.email,
        password: password.password,
        status: password.status
    }));

    let result = null;
    if (contextID === 0) {
        const command = 'UPDATE _Passwords SET `Content` = ? WHERE `ID` = ? AND `UserID` = ? AND `ContextID` IS NULL';
        const args = [ content, password.ID, profile.user.ID ];
        result = await db.QueryPrepare(command, args);
    } else {
        const command = 'UPDATE _Passwords SET `Content` = ? WHERE `ID` = ? AND `UserID` = ? AND `ContextID` = ?';
        const args = [ content, password.ID, profile.user.ID, contextID ];
        result = await db.QueryPrepare(command, args);
    }

    if (result === null || result.affectedRows === 0) {
        return {
            status: 1,
            password: null
        };
    }

    return {
        status: 0,
        password: {
            ID: password.ID,
            category: password.category,
            service: password.service,
            email: password.email,
            password: '**********',
            status: password.status
        }
    };
}

/** @type {TCPFeatureType<'delete-password'>} */
async function DeletePassword({ db, profile, data }) {
    const { contextID, passwordID } = data;

    let result = null;

    if (contextID === 0) {
        result = await db.QueryPrepare(
            'DELETE FROM _Passwords WHERE `ID` = ? AND `UserID` = ? AND `ContextID` IS NULL',
            [ passwordID, profile.user?.ID ]
        );
    } else {
        result = await db.QueryPrepare(
            'DELETE FROM _Passwords WHERE `ID` = ? AND `UserID` = ? AND `ContextID` = ?',
            [ passwordID, profile.user?.ID, contextID ]
        );
    }

    if (result === null) {
        return {
            status: 1
        };
    }

    return {
        status: 0
    };
}

export { AddPassword, EditPassword, DeletePassword };
