export interface ExternalService {
    /** Le nom du service, comme « Open-Meteo ». */
    name: string;
    /** À quoi il sert, en une phrase courte. */
    purpose: string;
    /** Ce qu’il reçoit de vous, en une phrase courte. */
    receives: string;
    /** Les fonctionnalités qui l’appellent : le service ne s’affiche que si l’une d’elles est installée. */
    features?: readonly string[];
    /** Seulement sur l’instance officielle (hébergeur, e-mails de compte, paiement). */
    official?: true;
}

/** Les tiers que DevEye appelle, le socle d’abord ; le nom sert de clé. */
export const EXTERNAL_SERVICES: readonly ExternalService[] = [
    {
        name: 'Hostinger International Ltd',
        purpose: 'Héberge les serveurs et les sauvegardes, et achemine les e-mails du service',
        receives: 'Ce que vous enregistrez dans DevEye, et les e-mails qui vous sont envoyés',
        official: true
    },
    {
        name: 'Stripe',
        purpose: 'Encaisse les abonnements',
        receives: 'Votre nom, votre adresse e-mail et votre moyen de paiement, que DevEye ne voit jamais',
        features: ['x-billing'],
        official: true
    },
    {
        name: 'Google',
        purpose: 'Fournit l’icône des raccourcis de votre accueil',
        receives: 'Le domaine de chaque raccourci, depuis votre navigateur'
    },
    {
        name: 'Discord',
        purpose: 'Publie dans votre salon les avis que vous y branchez',
        receives: 'Le contenu de ces avis'
    },
    {
        name: 'ipify',
        purpose: 'Affiche votre adresse IP publique, si vous ajoutez ce widget à votre barre',
        receives: 'Votre adresse IP, depuis votre navigateur'
    },
    {
        name: 'icanhazip',
        purpose: 'Prend le relais d’ipify quand il ne répond pas',
        receives: 'Votre adresse IP, depuis votre navigateur'
    },
    {
        name: 'ipwho.is',
        purpose: 'Situe une adresse IP : pays, drapeau et fournisseur d’accès',
        receives: 'Votre adresse IP publique, ou celle que vous recherchez dans OSINT'
    },
    {
        name: 'Let’s Encrypt',
        purpose: 'Délivre les certificats HTTPS des domaines que vous reliez et du serveur mail',
        receives: 'Le nom de domaine à certifier, qui devient public',
        features: ['uptime', 'projects', 'invoicing', 'x-rdv', 'x-hosting', 'mailserver']
    },
    {
        name: 'Gmail (Google)',
        purpose: 'Relie votre boîte Gmail sans vous demander son mot de passe',
        receives: 'Votre accord de connexion et les messages que vous envoyez',
        features: ['mail']
    },
    {
        name: 'Outlook (Microsoft)',
        purpose: 'Relie votre boîte Outlook sans vous demander son mot de passe',
        receives: 'Votre accord de connexion et les messages que vous envoyez',
        features: ['mail']
    },
    {
        name: 'GitHub',
        purpose: 'Lit vos dépôts, lance vos déploiements et cherche des comptes publics',
        receives: 'Votre jeton d’accès, les dépôts que vous désignez et les noms que vous recherchez',
        features: ['git', 'deploy', 'x-audit', 'osint']
    },
    {
        name: 'Open-Meteo',
        purpose: 'Prévisions météo et recherche des villes, sans clé',
        receives: 'La ville que vous saisissez et sa position',
        features: ['weather']
    },
    {
        name: 'OpenWeatherMap',
        purpose: 'Prévisions météo, avec votre propre clé',
        receives: 'Votre clé, la ville que vous saisissez et sa position',
        features: ['weather']
    },
    {
        name: 'Frankfurter',
        purpose: 'Taux de change publiés par la Banque centrale européenne',
        receives: 'Rien qui vous concerne',
        features: ['convert']
    },
    {
        name: 'NVD (NIST)',
        purpose: 'Base publique des failles de sécurité connues',
        receives: 'Les mots clés et identifiants de failles que vous recherchez',
        features: ['cve']
    },
    {
        name: 'Qonto',
        purpose: 'Importe les opérations de votre compte Qonto',
        receives: 'Votre clé d’accès Qonto',
        features: ['finance']
    },
    {
        name: 'Enable Banking',
        purpose: 'Relie votre compte bancaire, avec l’accord que vous donnez chez votre banque',
        receives: 'Votre choix de banque et votre consentement',
        features: ['finance']
    },
    {
        name: 'Stockage S3 de votre choix',
        purpose: 'Garde vos sauvegardes chez le fournisseur que vous configurez (Scaleway, Backblaze, AWS…)',
        receives: 'Vos sauvegardes, chiffrées si vous l’avez choisi',
        features: ['backup']
    },
    {
        name: 'Stockage WebDAV de votre choix',
        purpose: 'Garde vos sauvegardes sur un service comme kDrive ou Nextcloud',
        receives: 'Vos sauvegardes, chiffrées si vous l’avez choisi',
        features: ['backup']
    },
    {
        name: 'OSV.dev',
        purpose: 'Signale les dépendances vulnérables de vos dépôts',
        receives: 'Le nom et la version des dépendances analysées',
        features: ['x-audit']
    },
    {
        name: 'Cloudflare et Google Public DNS',
        purpose: 'Lisent les enregistrements DNS publics d’un domaine',
        receives: 'Le domaine ou l’adresse IP recherchés',
        features: ['osint']
    },
    {
        name: 'rdap.org',
        purpose: 'Donne le titulaire et les dates d’un domaine ou d’une adresse IP',
        receives: 'Le domaine ou l’adresse IP recherchés',
        features: ['osint']
    },
    {
        name: 'Annuaires WHOIS (IANA et registres)',
        purpose: 'Donnent la fiche d’enregistrement d’un domaine',
        receives: 'Le domaine recherché',
        features: ['osint']
    },
    {
        name: 'crt.sh',
        purpose: 'Liste les certificats émis pour un domaine',
        receives: 'Le domaine recherché',
        features: ['osint']
    },
    {
        name: 'VirusTotal',
        purpose: 'Réputation d’un domaine ou d’une adresse IP, avec votre clé',
        receives: 'Votre clé et le domaine ou l’adresse IP recherchés',
        features: ['osint']
    },
    {
        name: 'Shodan',
        purpose: 'Liste les services ouverts d’une adresse IP',
        receives: 'L’adresse IP recherchée, et votre clé si vous en donnez une',
        features: ['osint']
    },
    {
        name: 'SpamCop, Barracuda et Spamhaus',
        purpose: 'Disent si une adresse IP figure sur une liste noire de spam',
        receives: 'L’adresse IP recherchée, et votre clé Spamhaus si vous en donnez une',
        features: ['osint']
    },
    {
        name: 'Have I Been Pwned',
        purpose: 'Liste les fuites de données où figure une adresse e-mail, avec votre clé',
        receives: 'Votre clé et l’adresse e-mail recherchée',
        features: ['osint']
    },
    {
        name: 'Gravatar',
        purpose: 'Cherche le profil public lié à une adresse e-mail ou à un pseudonyme',
        receives: 'Une empreinte de l’adresse e-mail, ou le pseudonyme recherché',
        features: ['osint']
    },
    {
        name: 'keys.openpgp.org et keyserver.ubuntu.com',
        purpose: 'Cherchent les clés de chiffrement publiées pour une adresse e-mail',
        receives: 'L’adresse e-mail recherchée',
        features: ['osint']
    },
    {
        name: 'Keybase',
        purpose: 'Cherche un compte Keybase et ses preuves d’identité',
        receives: 'Le pseudonyme recherché',
        features: ['osint']
    },
    {
        name: 'Réseaux sociaux et forges de code',
        purpose: 'Une trentaine de sites (Reddit, Instagram, TikTok, GitLab…) disent si un pseudonyme y a un compte',
        receives: 'Le pseudonyme recherché',
        features: ['osint']
    },
    {
        name: 'Numverify',
        purpose: 'Donne l’opérateur d’un numéro de téléphone, avec votre clé',
        receives: 'Votre clé et le numéro recherché',
        features: ['osint']
    },
    {
        name: 'matchID',
        purpose: 'Cherche une personne dans le fichier public des décès de l’Insee',
        receives: 'Le nom recherché',
        features: ['osint']
    },
    {
        name: 'Annuaire des entreprises',
        purpose: 'Liste les sociétés qu’une personne dirige, d’après les données publiques de l’État',
        receives: 'Le nom et le prénom recherchés',
        features: ['osint']
    },
    {
        name: 'Pappers',
        purpose: 'Liste les mandats de dirigeant d’une personne, avec votre clé',
        receives: 'Votre clé et le nom recherché',
        features: ['osint']
    },
    {
        name: 'Wikidata',
        purpose: 'Cherche une personnalité publique et ses comptes officiels',
        receives: 'Le nom recherché',
        features: ['osint']
    }
];

/** Les services qui ont un aperçu dédié pour les raccourcis de l’accueil ; tout autre lien a un aperçu générique. */
export const LINK_PREVIEW_SERVICES: readonly string[] = [
    'GitHub',
    'npm',
    'Reddit',
    'SoundCloud',
    'Spotify',
    'TikTok',
    'Twitch',
    'Wikipédia',
    'YouTube'
];
