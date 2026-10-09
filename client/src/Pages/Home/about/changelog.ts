export type ChangeKind = 'added' | 'improved' | 'fixed' | 'removed';

export interface ChangelogEntry {
    version: string;
    date: string;
    changes: { kind: ChangeKind; text: string }[];
}

/**
 * Les notes de version, la plus récente en tête. La première porte la version de
 * `package.json` (`npm run check:changelog`).
 */
export const CHANGELOG: readonly ChangelogEntry[] = [
    {
        version: '0.24.5',
        date: '2026-10-09',
        changes: [
            {
                kind: 'added',
                text: 'Uptime : un onglet Intégrité dans les réglages d’un service, qui peut accepter sans alerte les changements de fichiers apportés par un déploiement réussi, repéré dans vos projets, vos déploiements, vos dépôts Git ou par une adresse que votre CI appelle'
            },
            {
                kind: 'added',
                text: 'Uptime : sur la fiche d’un service, le journal des intégrités s’affiche à côté de celui des mesures, avec chaque relecture des fichiers et le détail d’un écart'
            },
            {
                kind: 'fixed',
                text: 'Uptime : les journaux d’un service partagé depuis un autre espace affichent de nouveau leurs messages d’erreur'
            }
        ]
    },
    {
        version: '0.24.4',
        date: '2026-10-09',
        changes: [
            {
                kind: 'improved',
                text: 'L’en-tête de chaque fonctionnalité, avec ses onglets, reste visible en haut quand vous faites défiler'
            },
            {
                kind: 'improved',
                text: 'Uptime : la vérification des fichiers devient une option de chaque service, à son propre rythme, au lieu d’un type de contrôle à part'
            },
            {
                kind: 'fixed',
                text: 'Mail : changer de mode d’affichage avec un message ouvert ne dérègle plus l’apparence du reste de l’app'
            }
        ]
    },
    {
        version: '0.24.3',
        date: '2026-10-09',
        changes: [
            {
                kind: 'added',
                text: 'Audit : vos dépôts de Git s’analysent directement, sur une fiche refaite avec l’historique des rapports, les constats légitimes mis de côté et l’export en Markdown ou SARIF'
            },
            {
                kind: 'improved',
                text: 'Audit : des règles bien plus fiables et de nouvelles familles (jetons de services, workflows GitHub, cookies), vingt formats de dépendances, et les failles connues des outils (images Docker, versions de Node ou de Python)'
            },
            {
                kind: 'added',
                text: 'Audit : la recherche approfondie dans tout l’historique d’un dépôt, à la main ou automatique, et l’analyse à chaque commit, avec l’offre Pro'
            },
            {
                kind: 'added',
                text: 'Sauvegardes : toutes les catégories dans « Quoi sauvegarder », les adresses du Serveur mail, les dossiers hébergés et les volumes Docker en plus, et une sauvegarde ne lit que ce que son auteur a le droit de lire'
            },
            {
                kind: 'added',
                text: 'Accueil : une carte « Ajouter une fonctionnalité » au bout de chaque section, à masquer depuis le Profil'
            },
            {
                kind: 'improved',
                text: 'Une fonctionnalité réservée à l’offre Pro le dit et mène à l’offre, au lieu d’annoncer une limite de 0 atteinte'
            },
            { kind: 'fixed', text: 'Autres ajustements graphiques' }
        ]
    },
    {
        version: '0.24.2',
        date: '2026-10-07',
        changes: [
            {
                kind: 'added',
                text: 'Projets : une recherche sur le tableau, les tâches archivées dans l’historique, et la popup d’une tâche qui s’ouvre d’un seul mouvement'
            },
            {
                kind: 'fixed',
                text: 'Sentinelle : bien moins de fausses alertes (appareil éteint, ports dynamiques, fichiers livrés par un paquet), et les constats d’une même règle se règlent d’un geste'
            },
            {
                kind: 'fixed',
                text: 'Abonnement : une résiliation faite depuis le portail de paiement s’affiche comme telle, et l’historique des paiements reste visible après'
            },
            {
                kind: 'improved',
                text: 'Hébergement : l’adresse d’un dossier sous son titre, et un bandeau pour créer la première quand il n’en a pas'
            },
            {
                kind: 'fixed',
                text: 'Inscription : l’erreur s’affiche sur le bon champ, et la coche de réussite n’est plus un disque plein'
            },
            { kind: 'fixed', text: 'Un téléchargement ne coupe plus les mises à jour en direct sous Firefox' },
            {
                kind: 'fixed',
                text: 'Valider une confirmation par Entrée ne valide plus aussi la fenêtre qui est dessous'
            }
        ]
    },
    {
        version: '0.24.1',
        date: '2026-10-06',
        changes: [
            {
                kind: 'fixed',
                text: 'Une vue refermée ne se rouvre plus d’elle-même après un passage par une tuile d’appareil ou un lien vers une autre fonctionnalité'
            },
            {
                kind: 'fixed',
                text: 'Mail, Appareils, Git et Abonnement : un échec ne relance plus la requête (quand la fin de la vue est atteinte) en boucle et Mail propose « Réessayer »'
            },
            {
                kind: 'improved',
                text: 'Appareils : supprimer un appareil retire aussi le service et l’icône de son agent'
            },
            {
                kind: 'fixed',
                text: 'Auto-hébergement : changer la clé du serveur ne rend plus illisibles les fichiers hébergés'
            }
        ]
    },
    {
        version: '0.24.0',
        date: '2026-10-06',
        changes: [
            {
                kind: 'added',
                text: 'Thème clair, choisi par appareil dans le Profil, ou qui suit le lever et le coucher du soleil'
            },
            {
                kind: 'added',
                text: 'Facturation : acompte annoncé sur un devis, et documents à dupliquer, archiver ou copier vers un autre espace'
            },
            {
                kind: 'improved',
                text: 'Facturation : pages repensées, mobile compris, désignations sur plusieurs lignes et total juste des brouillons'
            },
            { kind: 'added', text: 'Mail : images distantes autorisées pour toute une boîte' },
            { kind: 'added', text: 'Appareils : démarrage automatique de l’agent réglable depuis sa popup' },
            { kind: 'added', text: 'Administration : page Services externes, avec l’état de chaque dépendance' },
            {
                kind: 'improved',
                text: 'CloudSync : progression des points de restauration, un point par jour gardé 30 jours par défaut'
            },
            {
                kind: 'improved',
                text: 'Rendez-vous : ligne de l’heure présente, et survol qui relie les heures à leurs rendez-vous'
            }
        ]
    },
    {
        version: '0.23.1',
        date: '2026-10-05',
        changes: [
            {
                kind: 'fixed',
                text: 'CloudSync : un dossier simplement lu sur l’appareil ne relance plus la synchronisation en boucle'
            },
            {
                kind: 'improved',
                text: 'CloudSync : le serveur tient mieux la charge quand de nombreux partages s’analysent en même temps'
            }
        ]
    },
    {
        version: '0.23.0',
        date: '2026-10-05',
        changes: [
            {
                kind: 'added',
                text: 'Git : plusieurs dépôts ajoutés d’un coup, et le propriétaire choisi parmi les comptes du jeton'
            },
            {
                kind: 'added',
                text: 'CloudSync : une ligne par fichier en erreur dans le Journal, à réessayer, exclure ou ignorer, et pourcentage de synchronisation sur les widgets'
            },
            {
                kind: 'improved',
                text: 'Accueil : transition animée vers l’organisation, le bouton d’organisation valide l’édition, et Maj+clic rouvre une vue à neuf'
            },
            {
                kind: 'improved',
                text: 'Barre du haut : les widgets des modules ouvrent leur fonctionnalité, leur popup s’anime depuis le widget, et les modèles d’accueil posent aussi leurs widgets'
            },
            {
                kind: 'improved',
                text: 'Journaux : une panne due à un réglage de l’utilisateur (domaine, webhook, boîte mail, dépôt) sort des avertissements de l’instance'
            },
            {
                kind: 'improved',
                text: 'Offres : plus de rendez-vous, de devis et de factures par mois, plus de bases pour Pro ; stockage hébergé et taille des conversions revus à la baisse'
            },
            { kind: 'improved', text: 'Hébergement : une offre sans stockage dit que l’hébergement est réservé à Pro' },
            { kind: 'fixed', text: 'Le bouton Annuler au pied d’une fenêtre la ferme bien' },
            {
                kind: 'fixed',
                text: 'Mail : compteurs de non-lus à jour à la lecture, et le Serveur mail ne mêle plus les compteurs de deux dossiers en IMAP'
            },
            {
                kind: 'fixed',
                text: 'Rendez-vous : une heure entamée par un rendez-vous se lit prise, sur une grille unique par type'
            },
            { kind: 'fixed', text: 'Icônes d’avertissement et de copie qui s’affichaient en carré plein' },
            {
                kind: 'fixed',
                text: 'Responsive : Sur téléphone, « Terminer » reste seul dans la barre pendant l’organisation de l’accueil'
            }
        ]
    },
    {
        version: '0.22.1',
        date: '2026-10-03',
        changes: [
            {
                kind: 'added',
                text: 'Recherche des fonctionnalités : tapez une lettre sur l’accueil ou ouvrez la loupe de la barre du haut, et installez-en une d’un geste'
            }
        ]
    },
    {
        version: '0.22.0',
        date: '2026-10-03',
        changes: [
            { kind: 'added', text: 'CloudSync : partages chiffrés de bout en bout, illisibles par le serveur' },
            {
                kind: 'improved',
                text: 'CloudSync : Journal à deux niveaux, erreurs qui disent leur cause, reprise des gros fichiers sans que l’appareil passe hors ligne, état affiché juste'
            },
            {
                kind: 'fixed',
                text: 'Appareils : logs de conteneur qui ne se vident plus sous un filtre, et mises à jour Flatpak avec l’agent en service'
            }
        ]
    },
    {
        version: '0.21.7',
        date: '2026-10-02',
        changes: [
            {
                kind: 'improved',
                text: 'Appareils : chaque outil de mise à jour est coché d’office, et les outils non pilotés se replient sous « Autres »'
            },
            {
                kind: 'fixed',
                text: 'Appareils : un échec de mise à jour système dit sa raison et son code en clair'
            }
        ]
    },
    {
        version: '0.21.6',
        date: '2026-10-02',
        changes: [
            {
                kind: 'improved',
                text: 'Appareils : le tableau des mises à jour s’affiche aussitôt, chaque outil complète son compte à son rythme, et une case par outil remplace les boutons'
            }
        ]
    },
    {
        version: '0.21.5',
        date: '2026-10-01',
        changes: [
            {
                kind: 'added',
                text: 'Appareils : la fenêtre des logs prend tout l’écran, filtre ses sources par type et par état, et copie les lignes affichées'
            },
            {
                kind: 'added',
                text: 'Déploiements : le journal se colore selon ce que dit chaque ligne, se filtre, se copie, et suit un déploiement en cours'
            },
            { kind: 'improved', text: 'Un seul menu déroulant partout, avec une recherche dès que la liste s’allonge' },
            {
                kind: 'improved',
                text: 'Déploiements : le journal s’ouvre sans second appel au fournisseur, et les journaux de jobs GitHub se lisent en parallèle'
            },
            {
                kind: 'fixed',
                text: 'Appareils : une source de logs qui ne répond pas ne laisse plus la fenêtre charger sans fin'
            },
            { kind: 'fixed', text: 'Déploiements : un appareil hors ligne se revérifie à la minute' }
        ]
    },
    {
        version: '0.21.4',
        date: '2026-10-01',
        changes: [
            {
                kind: 'added',
                text: 'Notifications : une fonctionnalité qui prévient en son nom peut suivre les canaux cochés par ses éléments'
            },
            {
                kind: 'added',
                text: 'Audience : le site et la page d’état de DevEye sont mesurés, et le formulaire « Écris-moi » du site arrive dans ses retours'
            },
            {
                kind: 'improved',
                text: 'Déploiements : un seul avis par accès quand le lien se perd, qui nomme les cibles touchées'
            }
        ]
    },
    {
        version: '0.21.3',
        date: '2026-10-01',
        changes: [
            {
                kind: 'added',
                text: 'Déploiements : un avis sur vos canaux quand le lien avec une instance se perd, et quand il revient'
            },
            { kind: 'fixed', text: 'Le serveur n’empile plus les requêtes en base sous la charge' },
            {
                kind: 'fixed',
                text: 'Auto-hébergement : toutes les tables prennent la même collation, même sur un MySQL 8 neuf'
            }
        ]
    },
    {
        version: '0.21.2',
        date: '2026-10-01',
        changes: [
            {
                kind: 'added',
                text: 'Déploiements : une instance Dokploy qui n’est pas sur Internet se joint par l’agent d’un de vos appareils'
            },
            { kind: 'improved', text: 'La page se recharge d’elle-même après une mise à jour de DevEye' },
            { kind: 'improved', text: 'Les fenêtres suivent la hauteur de leur contenu sans à-coup' }
        ]
    },
    {
        version: '0.21.1',
        date: '2026-09-30',
        changes: [
            {
                kind: 'fixed',
                text: 'À propos : illustrations des fonctionnalités à leur taille, et onglets sans barre de défilement'
            }
        ]
    },
    {
        version: '0.21.0',
        date: '2026-09-29',
        changes: [
            { kind: 'added', text: 'Export de toutes vos données depuis le Profil' },
            {
                kind: 'added',
                text: 'Installation d’un appareil en une seule ligne de commande, avec des codes d’appairage réutilisables'
            },
            { kind: 'added', text: 'Icône de l’agent dans la zone de notification, qui indique son état' },
            { kind: 'added', text: 'Bases de données jointes par l’intermédiaire d’un de vos appareils' },
            { kind: 'added', text: 'Page d’état publique pour suivre la disponibilité de DevEye' },
            {
                kind: 'added',
                text: 'Nouveautés, services externes et crédits réunis dans l’À propos, ouvert par le numéro de version'
            },
            {
                kind: 'improved',
                text: 'Appareils : mises à jour système réunies dans un tableau, à approuver depuis le bandeau'
            }
        ]
    },
    {
        version: '0.20.3',
        date: '2026-09-27',
        changes: [
            { kind: 'added', text: 'Finances : connexions bancaires directes et import de relevés CSV ou OFX' },
            { kind: 'added', text: 'Uptime : pages de statut publiques, servies aussi sur votre propre domaine' },
            { kind: 'added', text: 'Projets : une page publique pour présenter le tableau d’un projet' },
            { kind: 'added', text: 'Sauvegardes : fichiers d’une machine, et destinations SFTP et WebDAV' },
            {
                kind: 'added',
                text: 'Déploiements : GitHub Actions à côté de Dokploy, et services d’une machine déployés par son agent'
            },
            {
                kind: 'added',
                text: 'Conditions acceptées à l’inscription, et suppression de votre compte par vous-même'
            }
        ]
    },
    {
        version: '0.20.1',
        date: '2026-09-24',
        changes: [
            { kind: 'added', text: 'Certificats HTTPS obtenus automatiquement pour vos domaines' },
            { kind: 'improved', text: 'Facturation : devis et factures ouverts sous le domaine de l’émetteur' },
            { kind: 'improved', text: 'Vérification d’un domaine qui explique chaque échec en clair' }
        ]
    },
    {
        version: '0.20.0',
        date: '2026-09-24',
        changes: [
            { kind: 'added', text: 'Convertisseur : fichiers, images, vidéos, devises et unités' },
            { kind: 'added', text: 'Facturation : devis et factures, acceptés en ligne par vos clients' },
            { kind: 'added', text: 'Page de maintenance quand le site ou une fonctionnalité est fermé' },
            { kind: 'improved', text: 'Projets : frise réglable, jalons colorés et colonnes réorganisables' },
            { kind: 'improved', text: 'Mail : relève plus rapide, liste des messages affichée sans attente' },
            { kind: 'improved', text: 'Réglages : fil d’Ariane, et bouton Enregistrer au pied des fenêtres' }
        ]
    },
    {
        version: '0.19.1',
        date: '2026-09-20',
        changes: [
            { kind: 'added', text: 'Connexion à une autre instance DevEye, dont les espaces s’ajoutent aux vôtres' },
            { kind: 'added', text: 'Copie d’un élément vers un autre espace' },
            { kind: 'fixed', text: 'Sécurité renforcée de l’agent' }
        ]
    },
    {
        version: '0.19.0',
        date: '2026-09-20',
        changes: [
            { kind: 'added', text: 'Inscription libre en trois étapes, validée par e-mail' },
            { kind: 'added', text: 'Serveur mail : des adresses hébergées par DevEye, ajoutées à Mail en un clic' },
            {
                kind: 'added',
                text: 'Offres avec des limites par fonctionnalité : services, appareils, dépôts, boîtes mail'
            },
            { kind: 'added', text: 'Audience : les retours des visiteurs de vos sites' },
            { kind: 'improved', text: 'Mail : ajout d’une boîte en étapes, avec le logo de chaque fournisseur' },
            { kind: 'fixed', text: 'Sécurité renforcée des comptes, des sessions et des appareils' }
        ]
    },
    {
        version: '0.18.2',
        date: '2026-09-03',
        changes: [
            { kind: 'improved', text: 'La tuile d’un appareil ouvre directement sa fiche dans Appareils' },
            { kind: 'added', text: 'Changement de pseudo' },
            { kind: 'improved', text: 'Un élément se modifie dans l’onglet Général de ses réglages' },
            { kind: 'fixed', text: 'Déplacement d’un élément vers un autre espace en quelques secondes' },
            {
                kind: 'fixed',
                text: 'Comptes rafraîchis en direct, et inscription sans passage par l’écran de connexion'
            }
        ]
    },
    {
        version: '0.18.0',
        date: '2026-09-02',
        changes: [
            {
                kind: 'added',
                text: 'Texte libre affiché à côté de votre curseur pour les autres membres, touche « / »'
            },
            { kind: 'added', text: 'Bouton de signalement pour envoyer un retour ou décrire un bug' },
            { kind: 'improved', text: 'Deux tuiles par rangée sur téléphone' },
            { kind: 'fixed', text: 'Tuiles des fonctionnalités complémentaires verrouillées comme les autres' }
        ]
    },
    {
        version: '0.17.2',
        date: '2026-09-01',
        changes: [
            { kind: 'added', text: 'Veille CVE : fil des vulnérabilités, recherche et CVE épinglées' },
            { kind: 'added', text: 'Puce « Mon IP » dans la barre du haut' },
            { kind: 'added', text: 'Déplacement d’un élément vers un autre espace' },
            { kind: 'improved', text: 'Permissions réglables élément par élément, appareils compris' },
            {
                kind: 'added',
                text: 'Appareils : conteneurs gérés depuis la fiche, et historique long terme parcourable'
            },
            { kind: 'improved', text: 'Un accueil vide propose des modèles pour démarrer' }
        ]
    },
    {
        version: '0.16.0',
        date: '2026-08-29',
        changes: [
            { kind: 'added', text: 'Finances : gestion des finances pour les particuliers et les petites entreprises' },
            { kind: 'added', text: 'Sauvegardes programmées vers un dossier, une machine ou un stockage S3' },
            {
                kind: 'added',
                text: 'Partage d’éléments entre espaces : Notes, Mail, Projets, Uptime, Déploiements et plus'
            },
            { kind: 'improved', text: 'Notifications par canaux, choisis pour chaque élément' },
            { kind: 'improved', text: 'Réglages présentés de la même façon dans toutes les fonctionnalités' },
            { kind: 'improved', text: 'Accueil : dossiers au glisser, catalogue d’ajout unique et fiche « À propos »' }
        ]
    },
    {
        version: '0.13.5',
        date: '2026-08-16',
        changes: [
            { kind: 'added', text: 'Accueil : des dossiers pour regrouper plusieurs tuiles' },
            {
                kind: 'improved',
                text: 'CloudSync : interface plus lisible, dossier cloud créé à partir d’un simple nom'
            },
            { kind: 'improved', text: 'Uptime : bande d’état sur chaque service et détail au survol' },
            { kind: 'improved', text: 'Sentinelle : un constat se marque comme réglé' },
            { kind: 'fixed', text: 'CloudSync : plus de blocage après un arrêt brutal' }
        ]
    },
    {
        version: '0.13.1',
        date: '2026-08-14',
        changes: [
            { kind: 'added', text: 'Déploiements : historique complet et journal en direct depuis Dokploy' },
            {
                kind: 'improved',
                text: 'Déploiements : applications chargées d’elles-mêmes, services surveillés en blocs'
            },
            {
                kind: 'improved',
                text: 'Projets : les onglets suivent le contenu du projet, et « + » propose l’action utile'
            },
            { kind: 'improved', text: 'OSINT : la tuile d’accueil montre les sondes et les clés' }
        ]
    },
    {
        version: '0.13.0',
        date: '2026-08-13',
        changes: [
            { kind: 'added', text: 'Audience : statistiques de fréquentation de vos sites, avec entonnoirs' },
            { kind: 'added', text: 'Projets : onglet Audience et en-tête qui reste visible au défilement' },
            { kind: 'improved', text: 'Sentinelle : notifications sur ses propres canaux, écran plus ramassé' },
            { kind: 'improved', text: 'Explorateur de fichiers : chemins Windows et chemin cliquable par dossier' },
            { kind: 'fixed', text: 'Journaux d’un appareil : une lecture trop longue s’arrête et le signale' }
        ]
    },
    {
        version: '0.12.0',
        date: '2026-08-12',
        changes: [
            {
                kind: 'added',
                text: 'OSINT : enquête sur un domaine, une adresse IP, un numéro, un e-mail ou un pseudo'
            },
            {
                kind: 'added',
                text: 'Sentinelle : surveillance de la sécurité des appareils, constats et ligne de base'
            },
            { kind: 'added', text: 'Monitoring : téléchargement d’un dossier entier en archive' },
            { kind: 'added', text: 'Monitoring : conteneurs parmi les sources de journaux' },
            { kind: 'improved', text: 'Profil : score de sécurité cliquable, et curseurs en direct désactivables' },
            { kind: 'fixed', text: 'Notes : annulation, flèches et sélection de nouveau fiables' }
        ]
    },
    {
        version: '0.10.5',
        date: '2026-08-11',
        changes: [
            {
                kind: 'improved',
                text: 'Mises à jour des paquets : une mise à jour en cours est visible et protégée pour tous'
            },
            { kind: 'improved', text: 'Appareils : les réglages de démarrage disent ce qu’ils ont fait' },
            { kind: 'fixed', text: 'Un appareil éteint n’apparaît plus en ligne' },
            { kind: 'fixed', text: 'Démarrage automatique de l’agent installé sans conflit' },
            { kind: 'fixed', text: 'Extinction à distance sur macOS' }
        ]
    },
    {
        version: '0.10.2',
        date: '2026-08-10',
        changes: [
            { kind: 'added', text: 'Un appareil peut être partagé entre plusieurs espaces' },
            { kind: 'improved', text: 'Monitoring : une seule durée de conservation par appareil' },
            { kind: 'improved', text: 'Mail : la synchronisation en arrière-plan garde la boîte à jour' },
            { kind: 'improved', text: 'Apparence et disposition d’un espace partagé mises à jour en direct' },
            { kind: 'fixed', text: 'Sécurité renforcée des commandes sensibles des appareils' }
        ]
    },
    {
        version: '0.10.0',
        date: '2026-08-10',
        changes: [
            { kind: 'added', text: 'Projets : tâches, sous-tâches, frise et messages pour chaque projet' },
            { kind: 'added', text: 'Bases de données : inventaire, alertes et gestion des tables' },
            { kind: 'added', text: 'Git : dépôts de l’espace, avec historique et demandes de fusion' },
            { kind: 'improved', text: 'Présence en direct jusque dans l’onglet ou la tâche ouverte par un membre' },
            { kind: 'improved', text: 'Monitoring : ordre des appareils au glisser-déposer' },
            { kind: 'improved', text: 'Cases à cocher aux couleurs du thème partout' }
        ]
    },
    {
        version: '0.9.0',
        date: '2026-08-06',
        changes: [
            { kind: 'added', text: 'Espaces partagés : invitations par lien et gestion des membres' },
            { kind: 'added', text: 'Rôles et permissions dans chaque espace' },
            { kind: 'added', text: 'Présence en direct : membres connectés et curseurs visibles' },
            { kind: 'added', text: 'Inscription sur invitation, et page Utilisateurs pour les administrateurs' },
            { kind: 'improved', text: 'Uptime, Mail, Météo et CloudSync propres à chaque espace' },
            { kind: 'fixed', text: 'Suspendre un compte coupe aussi sa session en cours' }
        ]
    },
    {
        version: '0.7.2',
        date: '2026-08-04',
        changes: [
            { kind: 'improved', text: 'Accueil : sections ajoutées à la demande' },
            { kind: 'improved', text: 'Mail et Uptime utilisables sur téléphone' },
            { kind: 'improved', text: 'Monitoring : vue des ports retravaillée' },
            { kind: 'fixed', text: 'Mail : liste des messages et boutons qui débordaient' },
            { kind: 'fixed', text: 'Un glisser-déposer involontaire pouvait figer la page' }
        ]
    },
    {
        version: '0.7.0',
        date: '2026-08-04',
        changes: [
            { kind: 'added', text: 'Mail : lecture et envoi depuis vos boîtes mail existantes' },
            { kind: 'added', text: 'Mots de passe : génération aléatoire depuis le formulaire' },
            { kind: 'added', text: 'Fenêtre « À propos » qui liste les services externes utilisés' },
            { kind: 'improved', text: 'Uptime : services réordonnés à la souris comme au doigt' }
        ]
    },
    {
        version: '0.6.7',
        date: '2026-07-31',
        changes: [
            { kind: 'improved', text: 'Uptime : ordre des services choisi par glisser-déposer' },
            { kind: 'removed', text: 'Uptime : tri automatique des services en panne, remplacé par votre ordre' },
            { kind: 'fixed', text: 'Uptime : alertes acceptées par Discord et Slack' }
        ]
    },
    {
        version: '0.6.6',
        date: '2026-07-31',
        changes: [
            { kind: 'added', text: 'Uptime : surveillance de vos services, historique et alertes en cas de panne' },
            { kind: 'added', text: 'Notes : archivage au lieu d’une suppression définitive' },
            { kind: 'improved', text: 'Notes : placement libre au glisser-déposer et couleurs du texte' },
            {
                kind: 'improved',
                text: 'Monitoring : fonctions de l’appareil réunies dans un menu, frise navigable au clavier'
            },
            { kind: 'improved', text: 'Explorateur de fichiers : affichage des fichiers cachés' },
            { kind: 'fixed', text: 'Monitoring : plus d’avalanche de relevés après une reconnexion' }
        ]
    },
    {
        version: '0.6.0',
        date: '2026-07-04',
        changes: [
            { kind: 'added', text: 'CloudSync : synchronisation chiffrée de dossiers entre vos appareils' },
            { kind: 'added', text: 'Terminal : choix de l’utilisateur par défaut et du comportement à la fermeture' },
            {
                kind: 'improved',
                text: 'Explorateur de fichiers : clic sur toute la ligne et dossier parent accessible'
            },
            { kind: 'improved', text: 'Mise à jour de l’agent sur plusieurs appareils à la fois' },
            { kind: 'fixed', text: 'Terminal : les symboles de l’invite s’affichent correctement' }
        ]
    },
    {
        version: '0.5.3',
        date: '2026-06-29',
        changes: [
            { kind: 'added', text: 'Monitoring : explorateur de fichiers avec recherche, téléchargement et envoi' },
            { kind: 'added', text: 'Monitoring : terminal distant interactif' },
            { kind: 'added', text: 'Monitoring : lecture des journaux de l’appareil, système, Docker ou fichiers' },
            { kind: 'added', text: 'Monitoring : extinction, redémarrage, mise en veille et verrouillage à distance' },
            { kind: 'fixed', text: 'Verrouillage d’un Mac à distance' }
        ]
    },
    {
        version: '0.5.2',
        date: '2026-06-28',
        changes: [
            { kind: 'added', text: 'Raccourcis Twitch : pastille en direct et ancienneté du dernier live' },
            { kind: 'improved', text: 'Redémarrage instantané de l’agent après une mise à jour' },
            { kind: 'improved', text: 'Icônes chargées dès le démarrage' },
            { kind: 'fixed', text: 'Désactiver le démarrage automatique n’arrête plus l’agent en cours' }
        ]
    },
    {
        version: '0.5.0',
        date: '2026-06-28',
        changes: [
            { kind: 'added', text: 'Accueil organisable en catégories : appareils, fonctionnalités et raccourcis' },
            { kind: 'added', text: 'Notes : titres, listes, séparateurs, mise en forme et export PDF' },
            { kind: 'added', text: 'Mise à jour automatique de l’agent, et des paquets de l’appareil' },
            { kind: 'improved', text: 'Reconnexion automatique, avec un bandeau quand la connexion est perdue' },
            {
                kind: 'improved',
                text: 'Fenêtres : Entrée valide, Échap ferme, et confirmation avant de perdre une saisie'
            }
        ]
    },
    {
        version: '0.2.5',
        date: '2026-06-22',
        changes: [
            { kind: 'added', text: 'Page Appareils pour les administrateurs, avec téléchargement de l’agent' },
            { kind: 'added', text: 'Agent disponible sur Windows' },
            { kind: 'added', text: 'Galerie d’apparence qui garde jusqu’à cinq fonds d’écran' },
            { kind: 'added', text: 'Monitoring : privilèges de l’agent, ports ouverts et détail des connexions' },
            { kind: 'improved', text: 'Compteurs des Notes et des Mots de passe visibles même verrouillés' }
        ]
    },
    {
        version: '0.2.0',
        date: '2026-06-21',
        changes: [
            { kind: 'added', text: 'Tableau de bord d’accueil avec widgets et fond d’écran personnalisable' },
            { kind: 'added', text: 'Mots de passe chiffrés, déverrouillés par votre mot de passe de compte' },
            { kind: 'added', text: 'Notes avec cases à cocher, dossiers et verrouillage par mot de passe' },
            {
                kind: 'added',
                text: 'Monitoring de vos appareils par un agent : santé, sécurité, processus et graphiques'
            },
            { kind: 'added', text: 'Météo avec ville principale et prévisions' },
            { kind: 'added', text: 'Double authentification, et journal d’activité pour les administrateurs' }
        ]
    }
];
