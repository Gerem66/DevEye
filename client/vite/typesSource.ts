import { existsSync } from 'node:fs';
import path from 'path';
import { WORKSPACE_DIR } from './paths';

const TYPES_SOURCE_DIR = path.join(WORKSPACE_DIR, 'DevEye-Types', 'src');

/**
 * En dev, `@deveye/types` se résout vers le checkout frère quand il existe.
 * Servi depuis `node_modules`, Vite le met en cache `immutable` sous un `?v=`
 * qui ne suit que package.json et le lockfile : un contrat édité en place y
 * restait invisible au navigateur, et rendait « Unknown command » sans cause
 * apparente. Le build prend toujours le paquet installé.
 */
export function typesSourceAliases(): Record<string, string> {
    if (!existsSync(path.join(TYPES_SOURCE_DIR, 'index.ts'))) return {};
    // Les sous-chemins AVANT le nu : l'alias remplace par préfixe, et
    // `@deveye/types/sdk` ne doit pas devenir `src/index.ts/sdk`.
    return {
        '@deveye/types/sdk/server': path.join(TYPES_SOURCE_DIR, 'sdk', 'server.ts'),
        '@deveye/types/sdk/client': path.join(TYPES_SOURCE_DIR, 'sdk', 'client.ts'),
        '@deveye/types/sdk/testing': path.join(TYPES_SOURCE_DIR, 'sdk', 'testing.ts'),
        '@deveye/types/sdk': path.join(TYPES_SOURCE_DIR, 'sdk', 'index.ts'),
        '@deveye/types': path.join(TYPES_SOURCE_DIR, 'index.ts')
    };
}
