import { FeatureRegistry } from './feature-registry';

import type { RequestCommands } from 'deveye-types';
import type Encryption from '@/Services/Encryption';
import type { Database } from '@/Database';
import type { ClientSession } from '@/Interfaces/IClient';

/** Helper function to handle typed feature execution */
export async function ExecuteFeature<T extends keyof RequestCommands>(
    action: T,
    params: { db: Database; crypt: Encryption; profile: ClientSession; data: RequestCommands[T]['input'] }
): Promise<RequestCommands[T]['output'] | { status: 'error'; message: string }> {
    const feature = FeatureRegistry[action];
    if (!feature) {
        return { status: 'error', message: 'Feature not implemented' };
    }
    return await feature(params);
}
