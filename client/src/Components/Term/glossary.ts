/** Une définition du glossaire : le titre de la popup et ses paragraphes. */
export interface GlossaryEntry {
    title: string;
    body: readonly string[];
}

/**
 * Le vocabulaire technique de l'interface, expliqué à quelqu'un qui débute en
 * informatique : deux ou trois phrases justes, sans autre jargon. Une entrée
 * sert partout où le terme apparaît, par `<Term id='…'>`.
 */
export const GLOSSARY = {
    zeroKnowledge: {
        title: 'Zero knowledge',
        body: [
            'Littéralement « connaissance nulle » : le service qui héberge vos données n’a pas de quoi les lire. Elles sont chiffrées avec une clé tirée de votre mot de passe, que le serveur ne conserve pas.',
            'Concrètement, tant que vous n’avez pas déverrouillé votre session, personne ne peut consulter ces données : ni l’administrateur du serveur, ni quelqu’un qui volerait la base de données.',
            'Deux contreparties. Rien ne peut travailler dessus en votre absence (pas de synchronisation ni d’alerte en arrière-plan). Et pendant que votre session est déverrouillée, le serveur les déchiffre en mémoire pour vous les afficher, puis oublie la clé.'
        ]
    },
    encryption: {
        title: 'Chiffrement',
        body: [
            'Chiffrer une donnée, c’est la brouiller avec une clé secrète : sans cette clé, elle est illisible, même pour qui met la main sur le fichier ou la base de données.',
            'Ce qui compte ensuite, c’est de savoir qui détient la clé : le serveur (pratique, il peut travailler seul) ou vous uniquement (plus sûr, mais rien ne se fait sans vous).'
        ]
    },
    twoFactor: {
        title: 'Double authentification (2FA)',
        body: [
            'Une seconde preuve demandée à la connexion, en plus du mot de passe : ici, un code à six chiffres que génère une application sur votre téléphone, et qui change toutes les trente secondes.',
            'Quelqu’un qui découvre votre mot de passe ne peut donc pas se connecter sans avoir aussi votre téléphone.'
        ]
    },
    webhook: {
        title: 'Webhook',
        body: [
            'Une adresse web fournie par un autre service (Discord, Slack, un outil maison…) sur laquelle DevEye envoie un message dès qu’un événement se produit.',
            'C’est la manière habituelle de faire parler deux services entre eux sans que personne n’ait à aller vérifier : l’information arrive d’elle-même.'
        ]
    },
    imap: {
        title: 'IMAP',
        body: [
            'Le protocole standard pour lire une boîte mail à distance : les messages restent chez votre fournisseur, et DevEye les consulte comme le ferait n’importe quelle application de messagerie.',
            'Votre fournisseur indique l’adresse et le port de son serveur IMAP dans son aide, souvent sous « configuration d’un client mail ».'
        ]
    },
    smtp: {
        title: 'SMTP',
        body: [
            'Le protocole standard pour envoyer un e-mail : quand vous écrivez un message, il est remis au serveur SMTP de votre fournisseur, qui l’achemine jusqu’au destinataire.',
            'C’est le pendant de l’IMAP, qui sert à la réception. Ses réglages se trouvent au même endroit dans l’aide de votre fournisseur.'
        ]
    },
    proxy: {
        title: 'Proxy',
        body: [
            'Un serveur intermédiaire par lequel passe une connexion. Le service contacté voit l’adresse du proxy, pas celle du serveur DevEye.',
            'Utile quand un réseau impose de passer par lui pour sortir, ou pour ne pas exposer l’adresse du serveur. Dans le doute, laissez-le désactivé.'
        ]
    }
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryTermId = keyof typeof GLOSSARY;
