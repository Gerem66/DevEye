export async function SequentialPromises<T>(promises: (() => Promise<T>)[]): Promise<T[]> {
    const results = [];
    for (const promise of promises) {
        results.push(await promise());
    }
    return results;
}

export async function Sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
