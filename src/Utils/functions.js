/**
 * Wait during 'ms' milliseconds
 * @param {Number} ms 
 * @returns {Promise<void>}
 */
function Sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export { Sleep };