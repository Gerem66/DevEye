import SQL from '../SQL.js';
import { RandomString } from '../Utils/Functions.js';
import { SendData } from '../Utils/Request.js';

/**
 * @template {import('./types.js').RequestTypes} T
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
 * Store all sessions with ID as key and value is: lastCount (for cache) and interval to check changes
 * @type {Object<string, { lastCount: number, interval: NodeJS.Timeout }>}
 */
const intervals = {};

/** @type {TCPFeatureType<'gamelife-set-loop'>} */
async function GetGameLifeData({ profile, data }) {
    // User listening to changes
    if (data.type === 'open') {
        // Generate a random ID
        const intervalID = RandomString(16);

        // Already exists, return error
        if (intervals[intervalID] !== undefined) {
            return { status: 1, intervalID: '' };
        }

        // Create a new interval loop
        intervals[intervalID] = {
            lastCount: 0, // Cache
            interval: setInterval(async () => {
                // Get the total count of accounts
                const request = await db_GL.ExecQuery('SELECT COUNT(*) as count FROM Accounts');

                // Check errors and if the data changed
                if (!request || !request.length) return;
                const newValue = request[0]?.count || 0;
                if (
                    !Object.prototype.hasOwnProperty.call(intervals, intervalID) ||
                    newValue === intervals[intervalID].lastCount
                ) {
                    return;
                }

                // Data changed => Update the lastCount and send the data
                intervals[intervalID].lastCount = newValue;
                SendData(profile.connection, 'gamelife-data', {
                    action: 'gamelife-data',
                    content: { status: 0, totalUserCount: newValue },
                    callbackID: intervalID
                });
                console.log('Send data');
            }, 1000)
        };

        // Instant response, to confirm the loop is open
        return { status: 0, intervalID };
    }

    // User stop listening
    else if (data.type === 'close' && data.intervalID && intervals[data.intervalID] !== undefined) {
        clearInterval(intervals[data.intervalID].interval);
        delete intervals[data.intervalID];
    }

    // Error
    return { status: 1, intervalID: '' };
}

export { GetGameLifeData };
