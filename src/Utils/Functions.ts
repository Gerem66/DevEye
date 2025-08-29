import os from 'os';

function GetLocalIP(): string {
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
 * @returns A random non-cryptographic string of the specified length.
 */
function RandomString(length: number): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export { GetLocalIP, RandomString };
