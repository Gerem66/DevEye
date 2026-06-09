function Sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function StrIsJson(str: string): boolean {
    try {
        JSON.parse(str);
    } catch (e) {
        void e;
        return false;
    }
    return true;
}

/**
 * @description Generate a non-cryptographic random string
 * @param length Length of the random string
 */
function RandomString(length: number = 8): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export { Sleep, StrIsJson, RandomString };
