# La page d'état publique

`statut.deveye.fr` dit à tout le monde, compte ou non, si DevEye fonctionne,
depuis quand il ne fonctionne plus, et ce qu'il en est de chaque
fonctionnalité. Elle ne sert à rien si elle tombe avec l'app : c'est pourquoi
elle vit ailleurs.

## 1. Pourquoi un conteneur à part

Un seul processus Node sert l'app (`LISTEN_PORT`) et la surface publique
(`PUBLIC_LISTEN_PORT`). Les pages de statut du module Uptime tombent donc avec
lui, et elles ne peuvent de toute façon pas dire que DevEye lui-même est tombé.

La page d'état est un petit service à part, dans le dépôt (`statuspage/`) mais
dans sa propre image (`statuspage/Dockerfile`) :

- elle mesure DevEye **de l'extérieur**, par son adresse publique, comme un
  visiteur : proxy et certificat compris ;
- elle garde sa mémoire dans **son propre fichier SQLite** (`node:sqlite`),
  jamais dans la base de DevEye, dont la panne est justement à noter ;
- elle ne charge rien de l'app au-delà de quelques fichiers purs (le contrat de
  la sonde, la mise en page des alertes, le style des pages de statut
  d'Uptime). `statuspage/boundary.test.ts` le vérifie sur le bundle réel : un
  import de `Utils/Env`, même indirect, la ferait planter au démarrage.

Sur le même serveur, une panne de la machine emporte les deux. La déplacer sur
une autre machine ne demande que de recréer le conteneur là-bas : elle ne
connaît DevEye que par son adresse publique.

## 2. Ce qu'elle mesure

Toutes les minutes (`STATUS_INTERVAL_SECONDS`), trois requêtes de 10 s au plus :

| Requête                             | Ce qu'elle dit                                                     |
| ----------------------------------- | ------------------------------------------------------------------ |
| `GET /` de l'app                    | un visiteur reçoit la page (200, HTML)                             |
| `GET /api/statuspage/probe`         | la base, la maintenance, la priorité, l'état de chaque module      |
| `GET /api/health` de la surface pub | les pages publiques (`STATUS_DEVEYE_PUBLIC_URL`, si elle est mise) |

La route de sonde (`src/Services/statusProbe.ts`) n'existe que si
`STATUS_PROBE_TOKEN` est posé, et répond 404 sans le bon jeton. Elle est tenue
15 s en cache, un seul calcul à la fois. Son contrat est privé au dépôt
(`src/Services/statusProbeContract.ts`) : l'image de la page ne dépend d'aucune
publication de `@deveye/types`.

Toutes les 10 minutes, avec les destinations des alertes (§5), elle relit aussi
sa propre balise Audience (`GET /api/statuspage/tracking`, même jeton) : la clé
du site que l'administrateur a déclaré pour elle depuis Tests et débogage
(`DEBUG.md` §4), et l'origine qui sert `/t.js`. Déclarée, la page l'embarque
dans son en-tête et n'ouvre sa politique de sécurité qu'à cette origine ;
retirée ou en pause, elle disparaît. Rien à régler dans l'env de la page, et
DevEye absent, la dernière balise connue reste et échoue en silence comme tout
script tiers.

### L'état d'un module

Du plus fort au plus faible :

1. Sa **maintenance** (`requests` ou `full`) : en maintenance. La préversion le
   cache aux non-administrateurs, donc à la page aussi.
2. Son propre verdict, `FeatureService.health()` s'il le donne (voir
   `FEATURE_SDK.md`) : ce que l'hôte ne peut pas voir, comme un port qu'il n'a
   pas pu ouvrir (Serveur mail). Borné à 2 s, au-delà il est dit perturbé.
3. Ce que l'hôte en voit (`src/Services/featureHealth.ts`, en mémoire) : une
   tâche de fond en échec 3 fois d'affilée, ou 5 commandes qui plantent en
   5 minutes. Un refus ordinaire (droit, quota) n'est pas une erreur.

Le coût pour DevEye est d'une requête par minute, faite de lectures en mémoire et
d'un `SELECT 1`. Un vrai parcours par module (les essais E2E de la page Tests et
débogage) a été écarté : il crée des comptes et envoie des mails.

## 3. Les états

| État           | Quand                                             | Compte comme     |
| -------------- | ------------------------------------------------- | ---------------- |
| Opérationnel   | tout répond                                       | disponible       |
| Perturbé       | priorité aux abonnés, module qui échoue en partie | disponible       |
| En maintenance | maintenance du site ou du module                  | **indisponible** |
| Hors service   | pas de réponse, erreur serveur, base injoignable  | indisponible     |

- **La maintenance est une indisponibilité** : le taux affiché est
  (opérationnel + perturbé) / mesures. Elle s'affiche comme telle, avec le
  message que DevEye montre à ses visiteurs.
- Une panne attend **deux mesures d'affilée** : un raté isolé n'en est pas une.
  Elle est alors datée de la première. La maintenance et toute amélioration
  s'appliquent aussitôt.
- Quand l'app est hors service ou en maintenance, chaque module et la surface
  publique **en héritent** : l'incident reste celui de l'app, il n'est pas
  recopié sur chacun.
- Si la page d'état elle-même s'arrête (plus de 3 intervalles sans mesure),
  l'incident en cours est fermé à la dernière mesure : ce temps-là n'est
  compté ni pour ni contre DevEye, les barres du jour le montrent sans mesure.

Chaque jour garde un compteur par état ; les incidents gardent leur début, leur
fin et leur cause. Rien de plus, 400 jours.

## 4. La page

- `/` : la vue d'ensemble. L'app, la surface publique, et les seuls modules
  touchés en ce moment ; tous les autres sont dans le sélecteur.
- `/<id>` : un module, par son identifiant (`/notes`, `/x-rdv`). C'est
  l'adresse vers laquelle l'app renvoie.
- Le sélecteur est une liste de liens (`<details>`) : sans JavaScript, et
  chaque vue a son adresse à partager.
- Le rendu reprend le style des pages de statut d'Uptime ; le script servi à
  côté remet les heures dans le fuseau du visiteur et relit la page chaque
  minute.

## 5. Les alertes

DevEye ne peut pas prévenir qu'il est tombé : la page d'état le fait, par les
**destinations de la cible Système** (`LOGS.md` §3).

- Elle les relit chez DevEye (`GET /api/statuspage/channels`) au démarrage puis
  toutes les 10 minutes, et garde la dernière liste : quand DevEye ne répond
  plus, elle sait encore qui prévenir.
- Les webhooks (Discord compris, en embed) partent d'elle ; les e-mails par le
  **SMTP du serveur** (`SMTP_*`), le compte Mail de l'espace étant hors de
  portée. `STATUS_ALERT_EMAIL` est prévenu en plus, même avant la première
  lecture.
- Une panne et son retour, pour l'app, la surface publique et un module hors
  service de lui-même. **Jamais une maintenance** : elle est annoncée. Une
  perturbation non plus : DevEye alerte déjà sur les tâches qui échouent.
- Seulement avec `ENVIRONMENT=prod`, et avec l'anti-rafale des alertes Système.

Les adresses et les URL de webhook sont donc copiées en clair sur le volume de
la page d'état : le traiter comme un secret.

## 6. Les liens depuis l'app

`STATUS_PAGE_URL` côté DevEye (vide, aucun lien) arrive au client par
`/api/status` et y reste tant que l'onglet est ouvert. Le lien, dans un nouvel
onglet, n'apparaît qu'aux endroits où l'on se demande si c'est DevEye :

- la page de maintenance ;
- « Serveur injoignable » à la connexion ;
- une fonctionnalité qui plante à l'affichage, vers sa propre page ;
- une fonctionnalité en maintenance, vers sa propre page.

Sur une instance distante, le lien mène à la vue d'ensemble : la page d'état ne
suit que ce serveur. Et quand DevEye est entièrement tombé, l'app ne se charge
plus du tout : seul un onglet déjà ouvert montre le lien, d'où celui du site
vitrine.

## 7. Configuration

Côté DevEye : `STATUS_PAGE_URL`, `STATUS_PROBE_TOKEN` (32 caractères au moins).

Côté page d'état (`statuspage/.env.template`) :

| Variable                   | Rôle                                                      |
| -------------------------- | --------------------------------------------------------- |
| `ENVIRONMENT`              | les alertes ne partent qu'en `prod`                       |
| `STATUS_LISTEN_PORT`       | 3100 par défaut                                           |
| `STATUS_DEVEYE_URL`        | l'app, par son adresse publique                           |
| `STATUS_DEVEYE_PUBLIC_URL` | la surface publique, si elle a son domaine                |
| `STATUS_PROBE_TOKEN`       | le même que DevEye                                        |
| `STATUS_DB_PATH`           | `/data/status.sqlite` dans l'image, sur un volume         |
| `STATUS_INTERVAL_SECONDS`  | 60 par défaut, 15 au moins                                |
| `STATUS_SITE_URL`          | le site vitrine, au pied de la page                       |
| `STATUS_ALERT_EMAIL`       | un destinataire toujours prévenu                          |
| `SMTP_*`                   | l'expéditeur des e-mails d'alerte, comme celui du serveur |

En dev : `npm run dev:status` (lit `statuspage/.env`), avec `STATUS_DEVEYE_URL`
sur le client Vite : sans build du client, le port 3000 ne sert pas l'accueil. Le
déploiement est dans `deploy/README.md`.
