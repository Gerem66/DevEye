import { parsePhoneNumberFromString, type PhoneNumber } from 'libphonenumber-js/max';

// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { fetchJson } from '@/Services/netFetch';
import { field, tag, type OsintProbeAdapter, type OsintScore, type OsintTag } from './shared';

/**
 * Analyse d'un numéro, hors-ligne : `libphonenumber-js` embarque les plages
 * d'attribution, aucun appel réseau pour la donnée la plus sensible de la feature.
 *
 * Import de `/max` et non du paquet racine : seul ce jeu de métadonnées porte le
 * type de ligne (mobile / fixe / VoIP / surtaxé), dont le score dépend.
 *
 * Numverify, si une clé est posée, ajoute l'opérateur réel (portages compris).
 */

const TYPE_LABELS: Record<string, string> = {
    MOBILE: 'Mobile',
    FIXED_LINE: 'Fixe',
    FIXED_LINE_OR_MOBILE: 'Fixe ou mobile',
    VOIP: 'VoIP',
    PREMIUM_RATE: 'Surtaxé',
    TOLL_FREE: 'Gratuit',
    SHARED_COST: 'Coût partagé',
    PERSONAL_NUMBER: 'Numéro personnel',
    PAGER: 'Téléavertisseur',
    UAN: 'Numéro universel',
    VOICEMAIL: 'Messagerie'
};

/**
 * Chaque signal est affiché avec sa contribution : un score qui ne montre pas
 * son calcul ne peut pas être contredit. Le total part de 50.
 */
function scoreOf(parsed: PhoneNumber | undefined, type: string | undefined): OsintScore {
    const signals: { label: string; delta: number }[] = [];
    let value = 50;

    const push = (label: string, delta: number): void => {
        signals.push({ label, delta });
        value += delta;
    };

    if (!parsed) {
        return {
            value: 0,
            label: 'Non analysable',
            tone: 'bad',
            signals: [{ label: 'Le numéro n’a pas pu être interprété', delta: -50 }]
        };
    }

    if (parsed.isValid()) push('Numéro dans une plage réellement attribuée', +40);
    else push('Hors des plages attribuées du pays', -45);

    if (parsed.country) push(`Pays identifié (${parsed.country})`, +5);
    else push('Pays indéterminé', -10);

    switch (type) {
        case 'MOBILE':
            push('Ligne mobile', +20);
            break;
        case 'FIXED_LINE':
            push('Ligne fixe', +15);
            break;
        case 'FIXED_LINE_OR_MOBILE':
            push('Ligne fixe ou mobile', +10);
            break;
        case 'VOIP':
            // Une ligne VoIP s'obtient en ligne, en quelques minutes, souvent
            // sans pièce d'identité : c'est le marqueur de numéro jetable.
            push('Ligne VoIP — attribuable à la demande, souvent jetable', -30);
            break;
        case 'PREMIUM_RATE':
            push('Numéro surtaxé — jamais une ligne personnelle', -40);
            break;
        case 'TOLL_FREE':
            push("Numéro gratuit — ligne d'entreprise, pas d'un particulier", -15);
            break;
        case 'SHARED_COST':
        case 'UAN':
            push("Numéro de service d'entreprise", -10);
            break;
        case 'VOICEMAIL':
        case 'PAGER':
            push('Ligne non conversationnelle', -25);
            break;
        default:
            push('Type de ligne indéterminé', -20);
            break;
    }

    value = Math.max(0, Math.min(100, value));
    const label = value >= 75 ? 'Fiable' : value >= 45 ? 'Douteux' : 'Peu fiable';
    const tone = value >= 75 ? 'good' : value >= 45 ? 'warn' : 'bad';
    return { value, label, tone, signals };
}

/**
 * apilayer répond 200 même quand il refuse : l'échec est dans le corps, sous
 * `success: false`, et `info` n'est pas garanti. Sans lire `success`, un refus
 * (clé invalide, quota, plan gratuit limité à HTTP) ne laissait aucune trace :
 * ni champ, ni erreur, exactement comme une réponse vide.
 */
interface NumverifyResponse {
    success?: boolean;
    valid?: boolean;
    carrier?: string;
    line_type?: string;
    location?: string;
    country_name?: string;
    error?: { code?: number; type?: string; info?: string };
}

/** Ce qu'on affiche d'un refus, `info` manquant compris. */
function numverifyError(nv: NumverifyResponse): string | null {
    if (nv.success === false || nv.error) {
        const detail = nv.error?.info ?? nv.error?.type ?? 'refus sans explication';
        // Le plan gratuit d'apilayer ne sert que HTTP : le piège coûte une heure
        // à qui ne connaît pas, et le message brut ne le dit pas toujours.
        const hint =
            nv.error?.type === 'https_access_restricted' ? ' (le plan gratuit de Numverify ne permet pas HTTPS)' : '';
        return `${detail}${hint}`;
    }
    return null;
}

export const phoneProbe: OsintProbeAdapter = {
    id: 'phone',
    appliesTo: ['phone'],
    ttlMs: 24 * 60 * 60 * 1000,
    async run({ target, key }) {
        const raw = target.value;
        // Sans indicatif, `libphonenumber` a besoin d'un pays par défaut. La
        // France est le pari raisonnable ici : c'est la seule façon d'analyser
        // un « 06… » saisi tel qu'on l'écrit au quotidien.
        const parsed = raw.startsWith('+') ? parsePhoneNumberFromString(raw) : parsePhoneNumberFromString(raw, 'FR');

        const type = parsed?.getType();
        const score = scoreOf(parsed, type);

        if (!parsed) {
            return {
                status: 'empty',
                summary: 'Numéro non interprétable.',
                score
            };
        }

        const fields = [
            field('International', parsed.formatInternational(), { mono: true }),
            field('National', parsed.formatNational(), { mono: true }),
            field('E.164', parsed.number, { mono: true }),
            field('URI', parsed.getURI(), { mono: true })
        ];
        if (parsed.country) fields.push(field('Pays', parsed.country));
        if (parsed.countryCallingCode) fields.push(field('Indicatif', `+${parsed.countryCallingCode}`, { mono: true }));
        fields.push(field('Type de ligne', type ? (TYPE_LABELS[type] ?? type) : 'Indéterminé'));
        fields.push(field('Validité', parsed.isValid() ? 'Numéro attribué' : 'Hors plage attribuée'));

        const tags: OsintTag[] = [];
        tags.push(parsed.isValid() ? tag('Valide', 'good') : tag('Invalide', 'bad'));
        if (parsed.country) tags.push(tag(parsed.country, 'neutral'));
        if (type === 'MOBILE') tags.push(tag('Mobile', 'good'));
        if (type === 'VOIP') tags.push(tag('VoIP', 'warn'));
        if (type === 'PREMIUM_RATE') tags.push(tag('Surtaxé', 'bad'));
        if (type === 'TOLL_FREE') tags.push(tag('Gratuit', 'neutral'));

        // Enrichissement facultatif : l'opérateur réel, portages compris. Une clé
        // posée doit toujours laisser une trace de ce qu'elle a donné, ne
        // serait-ce que « rien » : sans cela, une clé refusée est indiscernable
        // d'une clé qui marche sur un numéro que le fournisseur ne connaît pas.
        if (key) {
            try {
                const nv = await fetchJson<NumverifyResponse>(
                    `https://apilayer.net/api/validate?access_key=${encodeURIComponent(key)}&number=${encodeURIComponent(parsed.number)}`
                );
                const refusal = numverifyError(nv);
                if (refusal) {
                    fields.push(field('Numverify', `Refusé : ${refusal}`));
                } else {
                    if (nv.carrier) fields.push(field('Opérateur (Numverify)', nv.carrier));
                    if (nv.location) fields.push(field('Zone (Numverify)', nv.location));
                    if (nv.line_type) fields.push(field('Type (Numverify)', nv.line_type));
                    if (!nv.carrier && !nv.location && !nv.line_type) {
                        fields.push(field('Numverify', 'Aucune donnée pour ce numéro'));
                    }
                }
            } catch (e) {
                fields.push(field('Numverify', `Injoignable : ${e instanceof Error ? e.message : String(e)}`));
            }
        }

        return {
            summary: `${parsed.formatInternational()} — ${type ? (TYPE_LABELS[type] ?? type) : 'type indéterminé'}, ${score.label.toLowerCase()}.`,
            fields,
            tags,
            score,
            links: key ? [] : [{ label: 'Enrichir avec Numverify (clé gratuite)', href: 'https://numverify.com/' }]
        };
    }
};
