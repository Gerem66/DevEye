import { useEffect, useState } from 'react';
import type { FeatureDomain, FeatureId } from '@deveye/types';

import { ws } from '@/api/ws';
import { humanizeError } from '@/api/useResource';
import { useResourceVersion } from '@/stores/invalidation';
import { useActiveWorkspace } from '@/stores/workspace';

const NONE: readonly FeatureDomain[] = [];

/**
 * Les domaines d'une fonctionnalité dans l'espace actif, tenus à jour : pour la
 * section Domaines de la coquille, et pour le formulaire d'un module qui en
 * désigne un.
 */
export function useDomains(feature: FeatureId): {
    domains: readonly FeatureDomain[];
    loading: boolean;
    error: string | null;
} {
    const version = useResourceVersion('domain.list');
    const workspaceId = useActiveWorkspace()?.id ?? null;
    const [state, setState] = useState<{ domains: readonly FeatureDomain[]; loading: boolean; error: string | null }>({
        domains: NONE,
        loading: true,
        error: null
    });

    useEffect(() => {
        if (workspaceId === null) return;
        let live = true;
        ws.send('domain.list', { feature })
            .then((res) => {
                if (live) setState({ domains: res.domains, loading: false, error: null });
            })
            .catch((failure: unknown) => {
                if (!live) return;
                setState((held) => ({
                    domains: held.domains,
                    loading: false,
                    error: humanizeError(failure, 'Les domaines n’ont pas pu être lus.')
                }));
            });
        return () => {
            live = false;
        };
    }, [feature, version, workspaceId]);

    return state;
}
