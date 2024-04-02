/**
 * @typedef {import('../SQL.js').default} SQL
 * @typedef {import('../Utils/Encryption.js').default} Encryption
 * @typedef {import('Types/TCP.js').SendRequestType} SendRequestType
 * @typedef {import('Types/TCP.js').ReceiveRequestType} ReceiveRequestType
 */

/**
 * @template {keyof SendRequestType} T
 * @typedef {import('Types/TCP.js').TCPRequestSendHeader<T>} TCPRequestSendHeader
 */

/**
 * @template {keyof ReceiveRequestType} T
 * @typedef {import('Types/TCP.js').TCPRequestReceiveHeader<T>} TCPRequestReceiveHeader
 */

/**
 * @param {SQL} db
 * @param {Encryption} crypt
 * @param {TCPRequestSendHeader<'add-password'>} data
 * @returns {Promise<TCPRequestReceiveHeader<'add-password'>>}
 */
async function AddPassword(db, crypt, data) {
    const { password } = data.content;

    const newPassword = {
        UserID: data.content.userID,
        ContextID: data.content.contextID || null,
        Content: crypt.Encrypt(JSON.stringify({
            category: password.category,
            service: password.service,
            email: password.email,
            password: password.password,
            status: password.status
        }))
    };

    let result = null;

    if (data.content.contextID === 0) {
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
            action: 'add-password',
            content: {
                status: 1,
                password: null
            },
            callbackID: data.callbackID
        };
    }

    return {
        action: 'add-password',
        content: {
            status: 0,
            password: {
                ID: result.insertId,
                category: password.category,
                service: password.service,
                email: password.email,
                password: '**********',
                status: password.status
            }
        },
        callbackID: data.callbackID
    };
}

/**
 * @param {SQL} db
 * @param {Encryption} crypt
 * @param {TCPRequestSendHeader<'edit-password'>} data
 * @returns {Promise<TCPRequestReceiveHeader<'edit-password'>>}
 */
async function EditPassword(db, crypt, data) {
    const { password } = data.content;

    const content = crypt.Encrypt(JSON.stringify({
        category: password.category,
        service: password.service,
        email: password.email,
        password: password.password,
        status: password.status
    }));

    let result = null;
    if (data.content.contextID === 0) {
        const command = 'UPDATE _Passwords SET `Content` = ? WHERE `ID` = ? AND `UserID` = ? AND `ContextID` IS NULL';
        const args = [ content, password.ID, data.content.userID ];
        result = await db.QueryPrepare(command, args);
    } else {
        const command = 'UPDATE _Passwords SET `Content` = ? WHERE `ID` = ? AND `UserID` = ? AND `ContextID` = ?';
        const args = [ content, password.ID, data.content.userID, data.content.contextID ];
        result = await db.QueryPrepare(command, args);
    }

    if (result === null || result.affectedRows === 0) {
        return {
            action: 'edit-password',
            content: {
                status: 1,
                password: null
            },
            callbackID: data.callbackID
        };
    }

    return {
        action: 'edit-password',
        content: {
            status: 0,
            password: {
                ID: password.ID,
                category: password.category,
                service: password.service,
                email: password.email,
                password: '**********',
                status: password.status
            }
        },
        callbackID: data.callbackID
    };
}

/**
 * @param {SQL} db
 * @param {TCPRequestSendHeader<'delete-password'>} data
 * @returns {Promise<TCPRequestReceiveHeader<'delete-password'>>}
 */
async function DeletePassword(db, data) {
    const { passwordID } = data.content;

    let result = null;

    if (data.content.contextID === 0) {
        result = await db.QueryPrepare(
            'DELETE FROM _Passwords WHERE `ID` = ? AND `UserID` = ? AND `ContextID` IS NULL',
            [ passwordID, data.content.userID ]
        );
    } else {
        result = await db.QueryPrepare(
            'DELETE FROM _Passwords WHERE `ID` = ? AND `UserID` = ? AND `ContextID` = ?',
            [ passwordID, data.content.userID, data.content.contextID ]
        );
    }

    if (result === null) {
        return {
            action: 'delete-password',
            content: {
                status: 1
            },
            callbackID: data.callbackID
        };
    }

    return {
        action: 'delete-password',
        content: {
            status: 0
        },
        callbackID: data.callbackID
    };
}

export { AddPassword, EditPassword, DeletePassword };
