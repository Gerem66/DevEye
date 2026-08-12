import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

import { field, type OsintLink, type OsintProbeAdapter, type OsintTargetKind } from './shared';

/**
 * Pivots : des requêtes composées, pas des pages récupérées.
 *
 * ## Pourquoi composer des liens plutôt que d'aller chercher les résultats
 *
 * Trois raisons, dans l'ordre d'importance :
 *  1. **Ça marche durablement.** Un scraper de moteur de recherche casse au
 *     prochain changement de balisage ; une URL de requête, non.
 *  2. **Ça ne fait pas blacklister le serveur.** Interroger Google depuis l'IP
 *     du serveur, pour tous les membres de l'espace, mène au captcha permanent.
 *  3. **Ça respecte les CGU** de moteurs qui interdisent tous l'extraction
 *     automatisée.
 *
 * Le résultat pratique est le même : un clic, et la recherche s'ouvre — mais
 * dans le navigateur de l'utilisateur, avec sa session et son IP à lui.
 *
 * C'est cette sonde qui porte les « recherches avancées sur nom/prénom » : la
 * valeur est dans les **opérateurs** (`site:`, guillemets, variantes de format),
 * qu'on ne tape pas à la main correctement.
 */

const g = (q: string): string => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const ddg = (q: string): string => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
const bing = (q: string): string => `https://www.bing.com/search?q=${encodeURIComponent(q)}`;

function personLinks(name: string): OsintLink[] {
    const exact = `"${name}"`;
    return [
        { label: 'Google — expression exacte', href: g(exact) },
        { label: 'Google — LinkedIn', href: g(`${exact} site:linkedin.com/in`) },
        {
            label: 'Google — réseaux sociaux',
            href: g(`${exact} (site:facebook.com OR site:x.com OR site:instagram.com)`)
        },
        {
            label: 'Google — documents (PDF, DOCX, XLSX)',
            href: g(`${exact} (filetype:pdf OR filetype:docx OR filetype:xlsx)`)
        },
        { label: 'Google — CV et annuaires', href: g(`${exact} (CV OR curriculum OR "mentions légales" OR annuaire)`) },
        { label: 'Bing', href: bing(exact) },
        { label: 'DuckDuckGo', href: ddg(exact) },
        { label: 'Pappers — dirigeants', href: `https://www.pappers.fr/recherche?q=${encodeURIComponent(name)}` },
        {
            label: 'societe.com — dirigeants',
            href: `https://www.societe.com/cgi-bin/liste?nom=${encodeURIComponent(name)}`
        },
        {
            label: 'Infogreffe',
            href: `https://www.infogreffe.fr/recherche-entreprise-dirigeants/chercher-un-dirigeant.html?dirigeant=${encodeURIComponent(name)}`
        },
        {
            label: 'Pages Blanches',
            href: `https://www.pagesjaunes.fr/pagesblanches/recherche?quoiqui=${encodeURIComponent(name)}`
        },
        {
            label: 'BODACC (annonces légales)',
            href: `https://www.bodacc.fr/pages/annonces-commerciales/?q=${encodeURIComponent(name)}`
        }
    ];
}

function phoneLinks(raw: string): OsintLink[] {
    const parsed = raw.startsWith('+') ? parsePhoneNumberFromString(raw) : parsePhoneNumberFromString(raw, 'FR');
    const e164 = parsed?.number ?? raw;
    const national = parsed?.formatNational() ?? raw;
    // Un numéro s'écrit de cinq façons différentes selon les sites : chercher
    // une seule forme, c'est passer à côté de la moitié des occurrences.
    const spaced = national;
    const compact = national.replace(/\s/g, '');
    const dotted = compact.replace(/(\d{2})(?=\d)/g, '$1.');

    const links: OsintLink[] = [
        { label: 'Google — toutes les écritures', href: g(`"${e164}" OR "${spaced}" OR "${compact}" OR "${dotted}"`) },
        {
            label: 'Google — petites annonces et fuites',
            href: g(`"${compact}" (contact OR annonce OR whatsapp OR telegram)`)
        },
        {
            label: 'Annuaire inversé — Pages Jaunes',
            href: `https://www.pagesjaunes.fr/annuaireinverse/recherche?quoiqui=${encodeURIComponent(compact)}`
        },
        {
            label: 'Annuaire inversé — 118712',
            href: `https://www.118712.fr/annuaire-inverse/${encodeURIComponent(compact)}`
        },
        { label: 'Truecaller', href: `https://www.truecaller.com/search/fr/${encodeURIComponent(compact)}` },
        { label: 'Signal-Arnaques', href: `https://www.signal-arnaques.com/search?q=${encodeURIComponent(compact)}` },
        { label: 'DuckDuckGo', href: ddg(`"${e164}" OR "${spaced}"`) }
    ];
    if (e164.startsWith('+')) {
        links.push({ label: 'WhatsApp (existence du compte)', href: `https://wa.me/${e164.replace('+', '')}` });
    }
    return links;
}

function emailLinks(email: string): OsintLink[] {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const localPart = email.slice(0, email.lastIndexOf('@'));
    return [
        { label: 'Google — adresse exacte', href: g(`"${email}"`) },
        { label: "Google — l'identifiant seul", href: g(`"${localPart}"`) },
        {
            label: 'Fuites connues (HIBP)',
            href: `https://haveibeenpwned.com/unifiedsearch/${encodeURIComponent(email)}`
        },
        { label: 'DeHashed', href: `https://www.dehashed.com/search?query=${encodeURIComponent(email)}` },
        { label: 'EmailRep', href: `https://emailrep.io/${encodeURIComponent(email)}` },
        {
            label: 'Hunter — schéma des adresses du domaine',
            href: `https://hunter.io/search/${encodeURIComponent(domain)}`
        },
        {
            label: 'GitHub — commits liés',
            href: `https://github.com/search?q=${encodeURIComponent(email)}&type=commits`
        }
    ];
}

function domainLinks(domain: string): OsintLink[] {
    return [
        { label: 'Google — tout le site', href: g(`site:${domain}`) },
        { label: 'Google — sous-domaines', href: g(`site:*.${domain} -site:www.${domain}`) },
        {
            label: 'Google — fichiers exposés',
            href: g(`site:${domain} (filetype:pdf OR filetype:xlsx OR filetype:sql OR filetype:env)`)
        },
        {
            label: 'Google — pages sensibles',
            href: g(`site:${domain} (inurl:admin OR inurl:login OR intitle:"index of")`)
        },
        { label: 'Wayback Machine', href: `https://web.archive.org/web/*/${domain}/*` },
        { label: 'urlscan.io', href: `https://urlscan.io/domain/${domain}` },
        { label: 'Shodan', href: `https://www.shodan.io/search?query=hostname%3A${encodeURIComponent(domain)}` },
        { label: 'Censys', href: `https://search.censys.io/search?resource=hosts&q=${encodeURIComponent(domain)}` },
        { label: 'VirusTotal', href: `https://www.virustotal.com/gui/domain/${encodeURIComponent(domain)}` },
        { label: 'SecurityTrails', href: `https://securitytrails.com/domain/${domain}/dns` },
        { label: 'BuiltWith — technologies', href: `https://builtwith.com/${domain}` },
        { label: 'crt.sh — certificats', href: `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}` }
    ];
}

function ipLinks(ip: string): OsintLink[] {
    return [
        { label: 'Shodan', href: `https://www.shodan.io/host/${encodeURIComponent(ip)}` },
        { label: 'Censys', href: `https://search.censys.io/hosts/${encodeURIComponent(ip)}` },
        { label: 'VirusTotal', href: `https://www.virustotal.com/gui/ip-address/${encodeURIComponent(ip)}` },
        { label: 'AbuseIPDB', href: `https://www.abuseipdb.com/check/${encodeURIComponent(ip)}` },
        { label: 'GreyNoise', href: `https://viz.greynoise.io/ip/${encodeURIComponent(ip)}` },
        { label: 'urlscan.io', href: `https://urlscan.io/ip/${encodeURIComponent(ip)}` },
        { label: 'BGP.tools', href: `https://bgp.tools/ip/${encodeURIComponent(ip)}` },
        { label: 'Google — mentions', href: g(`"${ip}"`) }
    ];
}

function usernameLinks(username: string): OsintLink[] {
    return [
        { label: 'Google — mentions exactes', href: g(`"${username}"`) },
        {
            label: 'Google — profils',
            href: g(`"${username}" (site:github.com OR site:reddit.com OR site:x.com OR site:instagram.com)`)
        },
        { label: 'WhatsMyName (sondage large)', href: `https://whatsmyname.app/?q=${encodeURIComponent(username)}` },
        {
            label: 'GitHub — utilisateurs',
            href: `https://github.com/search?q=${encodeURIComponent(username)}&type=users`
        },
        { label: 'Reddit', href: `https://www.reddit.com/user/${encodeURIComponent(username)}` },
        { label: 'DuckDuckGo', href: ddg(`"${username}"`) }
    ];
}

const BUILDERS: Record<OsintTargetKind, (value: string) => OsintLink[]> = {
    person: personLinks,
    phone: phoneLinks,
    email: emailLinks,
    domain: domainLinks,
    url: domainLinks,
    ip: ipLinks,
    username: usernameLinks
};

export const dorksProbe: OsintProbeAdapter = {
    id: 'dorks',
    appliesTo: ['domain', 'url', 'ip', 'email', 'phone', 'person', 'username'],
    // Purement calculé : rien à mettre en cache, et rien à en attendre.
    ttlMs: 0,
    async run({ target }) {
        const links = BUILDERS[target.kind](target.value);
        return {
            summary: `${links.length} recherches composées pour cette cible. Elles s'ouvrent dans votre navigateur, avec votre session — rien n'est interrogé par le serveur.`,
            fields: [field('Cible', target.value, { mono: true })],
            links
        };
    }
};
