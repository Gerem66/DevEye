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

export { Sleep, StrIsJson };
