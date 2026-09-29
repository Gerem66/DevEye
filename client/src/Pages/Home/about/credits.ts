export interface Credit {
    name: string;
    license: string;
    purpose: string;
}

export interface CreditGroup {
    title: string;
    items: readonly Credit[];
}

/** Ce sur quoi DevEye est bâti, licences relues dans chaque paquet installé. */
export const CREDITS: readonly CreditGroup[] = [
    {
        title: 'Interface',
        items: [
            { name: 'React', license: 'MIT', purpose: 'L’affichage de toute l’application' },
            { name: 'Framer Motion', license: 'MIT', purpose: 'Les animations' },
            { name: 'dnd kit', license: 'MIT', purpose: 'Le glisser-déposer des tuiles' },
            { name: 'xterm.js', license: 'MIT', purpose: 'Le terminal des appareils' },
            { name: 'Zod', license: 'MIT', purpose: 'La vérification des données échangées' }
        ]
    },
    {
        title: 'Serveur',
        items: [
            { name: 'Fastify', license: 'MIT', purpose: 'Le serveur web' },
            { name: 'ws', license: 'MIT', purpose: 'Les échanges en direct' },
            { name: 'MySQL2 et node-postgres', license: 'MIT', purpose: 'Les bases de données' },
            { name: 'Argon2 et bcrypt.js', license: 'MIT, BSD-3-Clause', purpose: 'Le hachage des mots de passe' },
            { name: 'jose', license: 'MIT', purpose: 'Les jetons de session' },
            { name: 'Nodemailer et smtp-server', license: 'MIT-0', purpose: 'L’envoi et la réception d’e-mails' },
            {
                name: 'ImapFlow, mailparser et mailauth',
                license: 'MIT',
                purpose: 'La lecture et la vérification des e-mails'
            },
            { name: 'isomorphic-git', license: 'MIT', purpose: 'La lecture des dépôts Git' },
            { name: 'ssh2', license: 'MIT', purpose: 'Les connexions SSH et SFTP' },
            { name: 'acme-client', license: 'MIT', purpose: 'Les certificats des domaines' },
            { name: 'Stripe', license: 'MIT', purpose: 'Le paiement des abonnements' },
            { name: 'sanitize-html', license: 'MIT', purpose: 'Le nettoyage des contenus affichés' },
            { name: 'libphonenumber-js', license: 'MIT', purpose: 'Les numéros de téléphone' },
            { name: 'node-qrcode', license: 'MIT', purpose: 'Les QR codes' },
            { name: 'Pino', license: 'MIT', purpose: 'Les journaux du serveur' }
        ]
    },
    {
        title: 'Polices',
        items: [
            { name: 'Open Sans', license: 'SIL OFL 1.1', purpose: 'Le texte de l’interface' },
            { name: 'Meslo LG et symboles Powerline', license: 'Apache-2.0, MIT', purpose: 'Le terminal' }
        ]
    }
];
