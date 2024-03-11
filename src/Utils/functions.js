/**
 * Wait during 'ms' milliseconds
 * @param {Number} ms 
 * @returns {Promise<void>}
 */
function Sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @param {string} str
 * @returns {boolean}
 */
function StrIsJson(str) {
    try { JSON.parse(str); }
    catch (e) { return false; }
    return true;
}

export { Sleep, StrIsJson };
