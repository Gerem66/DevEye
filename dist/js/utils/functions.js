function CopyContent(text) {
    navigator.clipboard.writeText(text)
    .then(() => window.location.reload())
    .catch(console.error);
}

function PreventResubmissionAlert() {
    if (window.history.replaceState) {
        window.history.replaceState(null, null, window.location.href);
    }
}

/**
 * @param {Number} min
 * @param {Number} value
 * @param {Number} max
 * @returns {Number}
 */
function MinMax(min, value, max) {
    if (value <= min) return min;
    else if (value > max) return max;
    return value;
}

/**
 * Wait during 'ms' milliseconds
 * @param {Number} ms 
 * @returns {Promise}
 */
function Sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @param {string} str
 * @returns {Boolean}
 */
function StrIsJson(str) {
    try { JSON.parse(str); }
    catch (e) { return false; }
    return true;
}