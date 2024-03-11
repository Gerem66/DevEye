import { StrIsJson } from './functions';

const LOCAL_KEYS = {
    user: 'data/user'
};

/**
 * @param {keyof LOCAL_KEYS} key
 * @param {string | Object} value
 */
function Save(key, value) {
    if (typeof value === 'object') {
        value = JSON.stringify(value);
    }
    localStorage.setItem(key, value);
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
