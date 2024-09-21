import os from 'os';

/**
 * @param {string} str
 * @returns {boolean}
 */
function StrIsJson(str) {
    try {
        JSON.parse(str);
    } catch (e) {
        return false;
    }
    return true;
}

/**
 * @returns {string} Local IP address
 */
function GetLocalIP() {
    const ifaces = os.networkInterfaces();
    let localIP = '';

    Object.keys(ifaces).forEach((ifname) => {
        ifaces[ifname]?.forEach((iface) => {
            if ('IPv4' !== iface.family || iface.internal !== false) {
                return '';
            }

            localIP = iface.address;
        });
    });

    return localIP;
}

/**
 * @param {Number} length
 * @returns {string}
 */
function RandomString(length) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export { StrIsJson, GetLocalIP, RandomString };
