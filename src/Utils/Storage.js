import { StrIsJson } from './Functions';

const LOCAL_KEYS = {
    token: 'data/token'
};

/**
 * @param {keyof LOCAL_KEYS} key
 * @param {string | Object} value
 */
function Save(key, value) {
    if (typeof value === 'object') {
        localStorage.setItem(key, JSON.stringify(value));
    } else if (typeof value === 'string') {
        localStorage.setItem(key, value);
    } else {
        throw new Error('Invalid type');
    }
}

/**
 * @param {keyof LOCAL_KEYS} key
 * @returns {string | Object | null}
 */
function Load(key) {
    let value = localStorage.getItem(key);
    if (value !== null && StrIsJson(value)) {
        value = JSON.parse(value);
    }
    return value;
}

/**
 * @param {keyof LOCAL_KEYS} key
 */
function Clear(key) {
    localStorage.removeItem(key);
}

export { Save, Load, Clear };
