type Config = {
    array?: (unknown[] | undefined)[];
    string?: (string | number | undefined)[];
    number?: (string | number | undefined)[];
    boolean?: (boolean | undefined)[];
};
export function CheckVars(config: Config): boolean {
    for (const [type, vars] of Object.entries(config)) {
        for (const value of vars) {
            if (type === 'array') {
                if (!Array.isArray(value) || value === undefined) {
                    return false;
                }
            } else if (value === undefined || typeof value !== type) {
                return false;
            }
        }
    }
    return true;
}

export function IsNotNull<T>(value: T | null): value is T {
    return value !== null;
}

export function SerializeError(error: Error | unknown) {
    if (!(error instanceof Error)) {
        return error;
    }
    return {
        message: error?.message,
        name: error?.name,
        stack: error?.stack,
        cause: error?.cause
    };
}

export function StrIsJson(str: string): boolean {
    try {
        JSON.parse(str);
    } catch (_e: unknown) {
        return false;
    }
    return true;
}

export function StrToJson<T = object>(str: string): T | null {
    try {
        return JSON.parse(str);
    } catch (_e: unknown) {
        return null;
    }
}

/**
 * Reduce the size of a big data object by keeping only the first and last half of each string field
 * @param data The data to reduce
 * @param maxVarLength The maximum length of each string field (default: 1000, implicit "+3" for the ellipsis)
 * @returns The reduced data object
 */
export function ReduceBigData(
    data: object,
    maxVarLength: number | null = 1000,
    maxVarCount: number | null = 10,
    maxLevel: number | null = 3
): Record<string, unknown> {
    const nextLevel = maxLevel === null ? null : maxLevel - 1;
    const reducedData = JSON.parse(JSON.stringify(data));

    for (const key of Object.keys(reducedData)) {
        // If is string
        if (typeof reducedData[key] === 'string' && maxVarLength && reducedData[key].length > maxVarLength) {
            reducedData[key] =
                reducedData[key].slice(0, maxVarLength / 2) + '...' + reducedData[key].slice(-maxVarLength / 2);
        }

        // If is array
        else if (Array.isArray(reducedData[key])) {
            if (nextLevel !== null && nextLevel <= 0) {
                reducedData[key] = [{ '...': '...' }];
                continue;
            }
            if (maxVarCount && reducedData[key].length > maxVarCount) {
                const firstPart = reducedData[key].slice(0, maxVarCount / 2);
                const lastPart = reducedData[key].slice(-maxVarCount / 2);
                reducedData[key] = firstPart
                    .concat(lastPart)
                    .map((item) => (item ? ReduceBigData(item, maxVarLength, maxVarCount, nextLevel) : item))
                    .concat({ '...': '...' });
            }
        }

        // If is object
        else if (typeof reducedData[key] === 'object' && reducedData[key]) {
            if (nextLevel !== null && nextLevel <= 0) {
                reducedData[key] = { '...': '...' };
            } else {
                reducedData[key] = ReduceBigData(reducedData[key], maxVarLength, maxVarCount, nextLevel);
            }
        }
    }
    return reducedData;
}
