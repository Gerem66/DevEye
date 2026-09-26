import { useCallback, useEffect, useState } from 'react';
import {
    OSINT_KIND_LABELS,
    OSINT_PRICING_LABELS,
    OSINT_PROBE_META,
    OSINT_PROBES_BY_KIND,
    OSINT_PROVIDER_META,
    osintProbeIdSchema,
    osintProbePricing,
    osintProbeUsable,
    osintTargetKindSchema,
    type OsintPricing,
    type OsintProbeId,
    type OsintProvider,
    type OsintTargetKind
} from '../contracts/domain';

import {
    humanizeError,
    invalidate,
    ProviderKeys,
    settingsStyles as shell,
    useResourceVersion,
    type ProviderKeyRow
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api } from './api';

/**
 * L'onglet Sondes : tout ce qu'OSINT interroge, avec son tarif et sa clé
 * éventuelle. Les sondes qu'une clé absente rend muettes passent en fin de
 * liste. La clé ne revient jamais du serveur, seulement le fait qu'elle existe.
 */

const PRICING_TONE: Record<OsintPricing, 'accent' | 'neutral' | 'warning'> = {
    free: 'accent',
    freemium: 'neutral',
    paid: 'warning'
};

const KIND_ICONS: Record<OsintTargetKind, string> = {
    domain: 'globe',
    url: 'globe',
    ip: 'server',
    email: 'mail',
    phone: 'chat',
    person: 'user',
    username: 'at'
};

/** Les natures de cible d'une sonde. Domaine et URL se confondent : même sonde, même hôte. */
function kindsOf(probe: OsintProbeId): OsintTargetKind[] {
    return osintTargetKindSchema.options.filter((k) => k !== 'url' && OSINT_PROBES_BY_KIND[k].includes(probe));
}

function rowOf(probe: OsintProbeId, held: ReadonlySet<OsintProvider>, group: string): ProviderKeyRow {
    const meta = OSINT_PROBE_META[probe];
    const provider = meta.key ? OSINT_PROVIDER_META[meta.key.provider] : null;
    const pricing = osintProbePricing(probe);
    const kinds = kindsOf(probe);
    const everywhere = kinds.length === osintTargetKindSchema.options.length - 1;

    const badges: ProviderKeyRow['badges'] = [{ label: OSINT_PRICING_LABELS[pricing], tone: PRICING_TONE[pricing] }];
    // Sans clé, l'intertitre « Indisponibles » le dit déjà ; avec, c'est ce qui
    // prévient que la retirer éteindrait la sonde.
    if (meta.key?.mode === 'required' && held.has(meta.key.provider)) {
        badges.push({ label: 'clé requise', tone: 'neutral' });
    }

    return {
        id: probe,
        label: meta.label,
        hint: `${everywhere ? 'Toutes cibles' : kinds.map((k) => OSINT_KIND_LABELS[k]).join(', ')} · ${meta.source}`,
        held: meta.key ? held.has(meta.key.provider) : false,
        needsKey: meta.key ? (meta.key.mode === 'optional' ? 'optional' : true) : false,
        signupUrl: provider?.signupUrl,
        icon: everywhere ? 'search' : KIND_ICONS[kinds[0]],
        issuer: provider?.label,
        keyHint: provider?.enables,
        badges,
        group
    };
}

export default function OsintProbesPanel({ canWrite }: SettingsPanelProps) {
    const [held, setHeld] = useState<ReadonlySet<OsintProvider> | null>(null);
    const [error, setError] = useState<string | null>(null);
    const keysVersion = useResourceVersion('osint.keyList');

    const load = useCallback(async () => {
        try {
            const res = await api.send('osint.keyList', {});
            setHeld(new Set(res.providers.filter((p) => p.hasKey).map((p) => p.provider)));
        } catch (e) {
            setError(humanizeError(e, 'Les clés n’ont pas pu être lues.'));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load, keysVersion]);

    const save = useCallback(async (probe: string, key: string) => {
        const provider = OSINT_PROBE_META[probe as OsintProbeId].key?.provider;
        if (!provider) return;
        setError(null);
        const res = await api.send('osint.setKey', { provider, key });
        setHeld((prev) => {
            const next = new Set<OsintProvider>(prev ?? []);
            if (res.hasKey) next.add(provider);
            else next.delete(provider);
            return next;
        });
        // Le widget de l'accueil, derrière ce dialogue, recompte ses sondes.
        invalidate('osint.keyList');
    }, []);

    // Avant la lecture des clés, l'état de chaque rangée serait un mensonge.
    if (!held) return error ? <p className={shell.notice}>{error}</p> : null;

    const probes = osintProbeIdSchema.options;
    const usable = probes.filter((p) => osintProbeUsable(p, held));
    const blocked = probes.filter((p) => !osintProbeUsable(p, held));
    const rows = [
        ...usable.map((p) => rowOf(p, held, `Utilisables (${usable.length})`)),
        ...blocked.map((p) => rowOf(p, held, `Indisponibles sans leur clé (${blocked.length})`))
    ];

    return (
        <>
            <p className={`${shell.sectionHint} ${shell.panelLead}`}>
                {usable.length} sondes sur {probes.length} sont prêtes
                {blocked.length > 0 && `, ${blocked.length} attendent leur clé`}. « Gratuit et payant » : le service
                offre un usage gratuit plafonné, et des offres payantes au-delà. Une clé facultative ne fait qu’enrichir
                sa sonde.
            </p>
            <ProviderKeys
                rows={rows}
                canWrite={canWrite}
                onSave={save}
                onRemove={(probe) => save(probe, '')}
                readOnlyHint='Votre rôle ne permet pas de modifier ces clés : elles relèvent de l’écriture sur OSINT.'
            />
            {error && <p className={shell.notice}>{error}</p>}
        </>
    );
}
