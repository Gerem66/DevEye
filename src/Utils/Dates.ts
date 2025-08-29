export function GetMillisecondsUntilMidnight() {
    const now = new Date();
    const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
    return msUntilMidnight;
}

/**
 * Get the current date in ISO format.
 */
export function GetFormattedDate(date = new Date()) {
    return date.toISOString();
}
