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