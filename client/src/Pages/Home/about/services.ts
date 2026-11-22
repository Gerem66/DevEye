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
        receives:
            'Votre nom et votre adresse e-mail, que DevEye lui transmet, et votre moyen de paiement, que DevEye ne voit jamais',
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
        receives: 'Votre adresse IP publique, depuis votre navigateur'
    },
    {
        name: 'Let’s Encrypt',
        purpose: 'Délivre les certificats HTTPS des domaines que vous reliez et du serveur mail',
        receives: 'Le nom de domaine à certifier, qui devient public',
        features: ['uptime', 'projects', 'invoicing', 'x-rdv', 'x-hosting', 'mailserver', 'shortlinks']
    },
    {
        name: 'DB-IP',
        purpose:
            'Fournit la base « IP to Country Lite » (licence CC BY 4.0), téléchargée chaque mois par le serveur, qui donne le pays des visiteurs',
        receives: 'Rien qui vous concerne : la base est lue sur le serveur, aucune adresse ne lui est envoyée',
        features: ['shortlinks']
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
        purpose: 'Lit vos dépôts et lance vos déploiements',
        receives: 'Votre jeton d’accès et les dépôts que vous désignez',
        features: ['git', 'deploy', 'x-audit']
    },
    {
        name: 'App Store Connect (Apple)',
        purpose:
            'Lit les téléchargements, les notes, les avis, les revenus et les versions de vos apps, et publie vos réponses aux avis',
        receives: 'Votre clé d’API App Store Connect, les apps que vous suivez et les réponses que vous publiez',
        features: ['appstores']
    },
    {
        name: 'Google Play (Google)',
        purpose:
            'Lit les installations, les notes, les avis, les ventes et la stabilité de vos apps, et publie vos réponses aux avis',
        receives: 'La clé de votre compte de service, les apps que vous suivez et les réponses que vous publiez',
        features: ['appstores']
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
        purpose: 'Signale les paquets vulnérables de vos dépôts',
        receives: 'Le nom et la version des paquets lus par la veille',
        features: ['cve']
    },
    {
        name: 'endoflife.date',
        purpose: 'Donne la fin de vie des systèmes, logiciels et frameworks que vous faites tourner',
        receives: 'Rien de vous : le catalogue entier se lit une fois par jour',
        features: ['cve']
    },
    {
        name: 'deps.dev',
        purpose: 'Dit si une dépendance de vos projets est dépréciée, ou en retard sur sa dernière version',
        receives: 'Le nom des dépendances que vos projets déclarent',
        features: ['cve']
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
