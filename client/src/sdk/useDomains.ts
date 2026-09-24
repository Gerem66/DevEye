import { useEffect, useState } from 'react';
import type { domainList, FeatureDomain, FeatureId } from '@deveye/types';
import type { z } from 'zod';

import { ws } from '@/api/ws';
import { humanizeError } from '@/api/useResource';
import { useResourceVersion } from '@/stores/invalidation';
import { useActiveWorkspace } from '@/stores/workspace';

const NONE: readonly FeatureDomain[] = [];

type ListOutput = z.infer<typeof domainList.output>;

interface DomainsState {
    domains: readonly FeatureDomain[];
    /** Null tant que la liste n'est pas lue, et pour des domaines qui ne sont pas web. */
    https: ListOutput['https'];
    quota: ListOutput['quota'];
    loading: boolean;
    error: string | null;
}

/**
 * Les domaines d'une fonctionnalité dans l'espace actif, tenus à jour : pour la
 * section Domaines de la coquille, et pour le formulaire d'un module qui en
 * désigne un.
 */
export function useDomains(feature: FeatureId): DomainsState {
    const version = useResourceVersion('domain.list');
    const workspaceId = useActiveWorkspace()?.id ?? null;
    const [state, setState] = useState<DomainsState>({
        domains: NONE,
        https: null,
        quota: null,
        loading: true,
        error: null
    });

    useEffect(() => {
        if (workspaceId === null) return;
        let live = true;
        ws.send('domain.list', { feature })
            .then((res) => {
                if (live) {
                    setState({ domains: res.domains, https: res.https, quota: res.quota, loading: false, error: null });
                }
            })
            .catch((failure: unknown) => {
                if (!live) return;
                setState((held) => ({
                    ...held,
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
