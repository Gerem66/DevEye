import SQL from '../SQL.js';
import { RandomString } from '../Utils/Functions.js';

/**
 * @typedef {import('./types.js').RequestTypes} RequestTypes
 */

/**
 * @template {keyof import('Types/TCP.js').ReceiveRequestType} T
 * @typedef {import('Types/TCP.js').TCPRequestReceiveHeader<T>} TCPRequestReceiveHeader
 */

/**
 * @template {RequestTypes} T
 * @typedef {import('./types.js').TCPFeatureType<T>} TCPFeatureType
 */

const db_GL = new SQL({
    database: process.env.DB_GL_DATABASE || '',
    hostname: process.env.DB_GL_HOSTNAME || '',
    username: process.env.DB_GL_USERNAME || '',
    password: process.env.DB_GL_PASSWORD || '',
    port: parseInt(process.env.DB_GL_PORT || '3306')
});

/**
 * @type {Object<string, { lastCount: number, timeout: NodeJS.Timeout}>}
 */
const intervals = {};

/** @type {TCPFeatureType<'gamelife-set-loop'>} */
async function GetGameLifeData({ profile, data }) {
    if (data.type === 'open') {
        const intervalID = RandomString(16);

        // Already exists, return error
        if (intervals[intervalID] !== undefined) {
            return { status: 1, intervalID: '' };
        }

        intervals[intervalID] = {
            lastCount: 0,
            timeout: setInterval(async () => {
                const request = await db_GL.ExecQuery('SELECT COUNT(*) as count FROM Accounts');

                if (!request || !request.length) return;
                const newValue = request[0]?.count || 0;
                if (
                    !Object.prototype.hasOwnProperty.call(intervals, intervalID) ||
                    newValue === intervals[intervalID].lastCount
                ) {
                    return;
                }

                intervals[intervalID].lastCount = newValue;
                profile.connection.send(
                    JSON.stringify(
                        /** @type {TCPRequestReceiveHeader<'gamelife-data'>} */ {
                            action: 'gamelife-data',
                            content: { status: 0, totalUserCount: newValue },
                            callbackID: intervalID
                        }
                    )
                );
                console.log('Send data');
            }, 1000)
        };

        return { status: 0, intervalID };
    } else if (data.type === 'close' && data.intervalID && intervals[data.intervalID] !== undefined) {
        clearInterval(intervals[data.intervalID].timeout);
        delete intervals[data.intervalID];
    }

    return { status: 1, intervalID: '' };
}

export { GetGameLifeData };
