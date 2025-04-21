import { StrIsJson } from './Functions';

const LOCAL_KEYS = {
    token: 'data/token'
};

function Save(key: keyof typeof LOCAL_KEYS, value: string | Object): void {
    if (Object.keys(LOCAL_KEYS).indexOf(key) === -1) {
        throw new Error('Invalid key');
    }

    if (typeof value === 'object') {
        localStorage.setItem(key, JSON.stringify(value));
    } else if (typeof value === 'string') {
        localStorage.setItem(key, value);
    } else {
        throw new Error('Invalid type');
    }
}

function Load(key: keyof typeof LOCAL_KEYS): string | Object | null {
    if (Object.keys(LOCAL_KEYS).indexOf(key) === -1) {
        throw new Error('Invalid key');
    }

    let value = localStorage.getItem(key);
    if (value !== null && StrIsJson(value)) {
        value = JSON.parse(value);
    }

    return value;
}

function Clear(key: keyof typeof LOCAL_KEYS): void {
    localStorage.removeItem(key);
}

export { Save, Load, Clear };
