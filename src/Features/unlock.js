import bcrypt from 'bcrypt';

/**
 * @typedef {import('../SQL.js').default} SQL
 * @typedef {import('../Server.js').ProfileType} ProfileType
 */

/**
 * Get authentification
 * @param {ProfileType} profile
 * @param {number} contextID
 * @returns {ProfileType['authentifications'][0] | null} Authentification
 */
function GetAuth(profile, contextID) {
    return profile.authentifications.find((a) => a.contextID === contextID) || null;
}

/**
 * Unlock context
 * @param {SQL} db
 * @param {ProfileType} profile
 * @param {number} contextID
 * @param {string | null} password
 * @returns {Promise<'unlocked' | 'wrong-user' | 'wrong-password' | 'error'>} Context unlocked
 */
async function Unlock(db, profile, contextID, password = null) {
    const context = profile.user?.Contexts.find((c) => c.id === contextID) || null;
    const contextAuth = GetAuth(profile, contextID);

    // Not user
    if (profile.user === null || context === null) {
        return 'wrong-user';
    }

    // Already unlocked
    if (contextAuth !== null) {
        if (contextAuth.resetTimeout !== null) {
            clearTimeout(contextAuth.resetTimeout);
        }

        contextAuth.passwordResetTime = Date.now() / 1000;
        contextAuth.resetTimeout =
            context.reAuthInterval === null
                ? null
                : setTimeout(
                      () => {
                          const index = profile.authentifications.findIndex((a) => a.contextID === contextID);
                          if (index !== -1) {
                              if (profile.authentifications[index].resetTimeout !== null) {
                                  clearTimeout(profile.authentifications[index].resetTimeout);
                              }
                              profile.authentifications.splice(index, 1);
                          }
                      },
                      1000 * 60 * context.reAuthInterval
                  );

        return 'unlocked';
    }

    // Get target hash
    let targetHash = null;
    if (contextID === 0) {
        const resultUser = await db.QueryPrepare('SELECT `Password` FROM `Users` WHERE `ID` = ?', [profile.user?.ID]);
        if (resultUser === null || resultUser.length === 0 || resultUser[0].Password === null) {
            return 'error';
        }
        targetHash = resultUser[0].Password;
    } else {
        const resultContext = await db.QueryPrepare('SELECT `Password` FROM `Contexts` WHERE `ID` = ?', [contextID]);
        if (resultContext === null || resultContext.length === 0) {
            return 'error';
        }
        if (resultContext[0].Password === null) {
            return 'unlocked';
        }
        targetHash = resultContext[0].Password;
    }

    if (password === null) {
        return 'wrong-password';
    }

    let match = targetHash === null;
    if (targetHash !== null) {
        if (targetHash.startsWith('$2y$')) {
            targetHash = '$2b$' + targetHash.substring(4);
        }

        try {
            const result = await bcrypt.compareSync(password, targetHash);
            match = result;
        } catch (error) {
            console.error(error);
        }
    }

    if (!match) {
        return 'wrong-password';
    }

    // Unlock
    if (contextAuth === null) {
        profile.authentifications.push({
            contextID,
            clearPassword: password,
            passwordResetTime: Date.now() / 1000,
            resetTimeout:
                context.reAuthInterval === null
                    ? null
                    : setTimeout(
                          () => {
                              const index = profile.authentifications.findIndex((a) => a.contextID === contextID);
                              if (index !== -1) {
                                  if (profile.authentifications[index].resetTimeout !== null) {
                                      clearTimeout(profile.authentifications[index].resetTimeout);
                                  }
                                  profile.authentifications.splice(index, 1);
                              }
                          },
                          1000 * 60 * context.reAuthInterval
                      )
        });
    }

    return 'unlocked';
}

export { Unlock, GetAuth };
