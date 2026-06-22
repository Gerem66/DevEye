import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The running DevEye version. Single source of truth = the server `package.json`
 * (the same one the web client bakes into `__APP_VERSION__`). Overridable via
 * `APP_VERSION` for images that stamp the build explicitly.
 */
let cached: string | null = null;

export function appVersion(): string {
    if (cached) return cached;
    cached =
        process.env.APP_VERSION ||
        process.env.npm_package_version ||
        (() => {
            try {
                return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')).version as string;
            } catch {
                return '0.0.0';
            }
        })();
    return cached;
}
