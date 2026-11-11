# Les opérations longues : un dialogue qui se réduit, une zone dans la barre

## La règle

Un geste qui dure (supprimer un point de restauration, déplacer un élément,
assembler un PDF) passe par `runTask`. Il s'ouvre dans un dialogue que l'on peut
**réduire** : l'opération continue, et se retrouve dans la **zone des
opérations** de la barre du haut, avec son avancement puis son résultat.

Aucun écran ne monte son propre dialogue d'attente, et aucun ne retient la
personne le temps d'un travail qui n'a pas besoin d'elle.

À l'écran on dit « opération » : « tâche » est le mot de Projets. Dans le code,
`task`.

## Deux sortes d'opération

- **Adossée à une commande** : une seule commande du serveur fait le travail et
  rapporte son avancement par `ctx.progress({ done, total, step })`. L'opération
  lui passe `task.sendOptions` : l'étiquette qui la fait **suivre par le
  serveur**, l'avancement branché sur elle, l'espace d'où elle est partie. Une
  coupure ou un rechargement ne la perd pas, et les autres onglets du compte la
  voient ([Ce que le serveur suit](#ce-que-le-serveur-suit)).
- **Locale** (`local: true`) : le travail se fait dans l'onglet, qui porte un
  élément d'un espace à l'autre, assemble un PDF, envoie des fichiers. Elle
  rapporte son avancement par `task.report({ value, step })`. Fermer l'onglet la
  tue : le navigateur demande confirmation tant qu'elle tourne, la déconnexion
  aussi, et le rechargement automatique qui suit une mise à jour attend sa fin
  (`api/version.ts`). Le serveur n'en sait rien, aucun autre onglet ne la voit.

`task.sendOptions` ne va qu'à LA commande qui est l'opération. Une suite de
commandes menée par le navigateur est une opération locale.

Un travail rapporte son avancement aussi souvent qu'il veut : le magasin n'en
publie que dix par seconde et par opération, le dernier toujours. Chaque
publication redessine les écrans qui lisent le magasin, et un assemblage qui
rapporte chaque page occuperait sinon le fil de l'écran à ne faire que cela.

## Le premier plan, puis la zone

Une opération naît **au premier plan** : un dialogue (`TaskDialog`) dit ce qui
se fait, où elle en est, et offre « Réduire ». Échap et le clic dehors réduisent
aussi. « Annuler » s'y ajoute quand l'opération sait s'arrêter.

Le dialogue n'apparaît qu'après 400 ms : un geste plus court ne clignote pas. Sa
couche est posée dès le lancement, donc l'écran du dessous ne se clique pas
entre-temps, et une invite ouverte pendant l'opération (le coffre, le code
d'application) passe au-dessus. Après huit secondes, il dit que c'est long et
rappelle qu'on peut réduire.

Réduite, l'opération est **détachée**, pour de bon : la rouvrir depuis le
panneau n'y change rien. De là vient la seule règle de fin :

- **jamais détachée**, elle sort sans trace, ici comme dans les autres onglets
  du compte : l'écran qui l'a lancée est resté dessous tout du long, et affiche
  le résultat lui-même ;
- **détachée**, son résultat reste dans la zone. Un succès part quand le panneau
  l'a montré puis s'est refermé, un échec reste jusqu'à sa croix.

Deux réglages changent ce départ :

- `minimizable: false` pour une étape dont la suite a besoin de la personne : la
  préparation d'une restauration, que suit une question, ou l'assemblage d'un
  PDF confié ensuite au Convertisseur. Réduite, la suite surgirait hors de
  propos, portée par un écran que la personne a quitté.
- `dialog: false` n'ouvre aucun dialogue : l'opération naît détachée et l'écran
  dessine l'avancement chez lui (la vérification d'intégrité d'un partage).

`onDetach` prévient l'appelant à la première réduction. Il sert à refermer la
fiche d'un élément qui s'en va, un partage qu'on supprime ou un élément qu'on
déplace : la refermer à la fin fermerait la fiche que la personne a ouverte
entre-temps.

## La zone des opérations

Une puce de la barre (`TasksStatus`), entre l'état du déploiement et les
widgets. Elle n'est pas un widget du catalogue : la disposition de l'accueil
appartient à l'espace, naît vide et se masque sur téléphone, alors qu'une
opération est à la personne et doit toujours avoir où aller. La puce n'existe
que lorsqu'une opération détachée tourne ou qu'un résultat attend.

| Ce qui attend             | La puce                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| une ou plusieurs en cours | l'indicateur qui tourne, le compte au-delà d'une, une mini-barre quand la seule en cours se mesure ; le bord prend le ton d'un échec ou d'une interruption à voir |
| un échec                  | la croix, au ton du danger                                                                                                                                        |
| une interruption          | le triangle, au ton de l'avertissement                                                                                                                            |
| des succès non vus        | la coche, au ton du succès                                                                                                                                        |

Son panneau, « Opérations », liste les opérations détachées, la plus récente
d'abord : la fonctionnalité, l'espace quand ce n'est pas l'actif, le titre, ce
sur quoi elle porte, puis la barre et l'étape, ou le résultat. « Afficher »
ramène le dialogue, « Annuler » arrête ce qui sait s'arrêter, « Ouvrir » retourne
à l'élément (bascule d'espace comprise, par la téléportation), la croix retire.
Un échec y est un `ErrorNote` : une panne s'y signale comme ailleurs.

La zone est celle du **compte** : une opération que le serveur suit y paraît
dans chaque onglet, sur chaque appareil. Là où elle n'a pas été lancée, elle
est toujours détachée : sa ligne n'a ni « Afficher » ni « Annuler » (le dialogue
et l'arrêt appartiennent à la page qui l'attend), et sa croix dit « Ne plus
suivre » tant qu'elle tourne. Retirer une ligne la retire de tous les onglets ;
un succès vu dans l'un est vu partout.

La barre passe **sous** le voile de tout dialogue ouvert, la puce avec elle. Un
écran qui vit dans un dialogue (l'historique d'un partage) dessine donc
l'avancement en place, par `TaskProgress`, qui porte « Afficher » quand la page
tient le dialogue.

## Ce que le serveur suit

`task.sendOptions` porte une **étiquette** (`task` de l'enveloppe,
`commandTaskSchema`) : l'id de l'opération, son titre, ce sur quoi elle porte,
sa fonctionnalité, son élément, sa clé, et les phrases de fin écrites en
chaîne. Les libellés sont ceux de l'appelant, et ne reviennent jamais qu'à son
compte. Une commande ainsi marquée entre dans le registre (`Services/tasks.ts`)
une fois ses gardes passées : un droit refusé n'est pas une opération en échec.

Le registre vit en mémoire, par compte. Il tient deux choses :

- **l'état** de l'opération, pour les autres onglets du compte. La trame
  `session` qui ouvre chaque socket porte la liste (`tasks`), puis `task.update`
  suit chaque avancement et la fin, et `task.removed` chaque retrait. La socket
  qui attend la réponse n'en reçoit rien : sa page suit l'opération par sa
  requête. Une opération n'est annoncée qu'après 300 ms, et son résultat
  300 ms après que la page qui l'attend l'a reçu : une commande éclair, ou un
  résultat que cette page retire aussitôt, ne clignote nulle part ;
- **la réponse** de la commande, pour la page qui l'attend. Elle part vers la
  socket qui la réclame à cet instant, pas forcément celle qui a envoyé la
  commande. Sans socket, elle est retenue dix minutes ; envoyée, encore une
  minute, la socket pouvant être déjà morte.

**Reprendre après une coupure.** Côté client, une requête marquée et déjà
partie n'est pas rejetée quand sa socket tombe (`api/ws.ts`). À la réouverture,
la page la réclame par `task.attach`, avec l'id de l'opération et le
`requestId` de la requête. L'id est diffusé à tout le compte, le `requestId`
ne l'est jamais : le présenter, depuis la session qui a lancé l'opération,
prouve qu'on attend cette réponse. Une opération en cours répondra à la
nouvelle socket, une opération finie rend sa réponse aussitôt, et ce que le
serveur ne connaît plus revient dans `lost`.

**La sonde.** Une commande marquée n'expire plus une fois partie. Après trente
secondes sans avancement, la page réclame l'opération de la même façon : le
serveur répond qu'il la tient, ou la socket, muette, est refermée pour forcer
une reconnexion. Un handler peut donc se taire longtemps.

**Après un rechargement**, la page n'attend plus rien : l'opération lui revient
par la liste d'ouverture, comme à n'importe quel autre onglet, et `useTasks` la
rend à l'écran remonté.

**Retirer.** `task.dismiss` retire un résultat de la zone du compte, dans tous
ses onglets. Sur une opération en cours, il ne fait que la délaisser : la
commande va à son terme, sa réponse part encore vers la page qui l'attend, et
plus rien n'en est montré. C'est l'issue de secours devant un handler qui ne
rend jamais la main.

**Ce qui n'est pas une fin.** Un refus qui se rejoue après une invite
(`locked`, `stepup_required`) efface l'opération au lieu de la dire en échec :
la commande repart sous le même id une fois l'invite passée.

**Dans un espace personnel que le mot de passe garde**, le registre ne montre
ni ne retient rien : un libellé ou une réponse peut citer ce que l'étage gardé
protège. Il sait seulement, tant que la commande tourne, à quelle socket
répondre. L'opération survit donc à une coupure si elle tourne encore au
retour, mais ne paraît dans aucun autre onglet et ne revient pas après un
rechargement ([SECURITY_MODEL.md](./SECURITY_MODEL.md)).

**Un redémarrage du serveur** oublie tout. La liste d'ouverture porte une
`epoch`, tirée à chaque démarrage : quand elle change, ce qui tournait est dit
**interrompu**, ici et dans les onglets qui le suivaient.

| Borne                               | Valeur                                     |
| ----------------------------------- | ------------------------------------------ |
| annonce aux autres onglets          | après 300 ms                               |
| résultat gardé                      | 24 h, ou jusqu'à son retrait               |
| réponse retenue                     | 10 min sans socket, 1 min une fois envoyée |
| réponse retenue, taille             | 256 Kio, et 1 Mio par compte               |
| opérations par compte               | 50 : la plus ancienne finie cède la place  |
| silence avant la sonde, côté client | 30 s                                       |

Une réponse plus lourde que la borne n'est pas retenue : après une coupure,
l'opération est dite terminée, et l'écran relit sa donnée. Passé le plafond du
compte, une commande marquée tourne sans être suivie.

## Ce que l'écran en sait

`useTasks({ feature, itemId?, key? })` rend les opérations **en cours** de la
fonctionnalité dans l'espace actif, quel que soit l'écran qui les a lancées, y
compris depuis un autre onglet. Un écran remonté pendant qu'une opération
tourne retrouve ainsi « occupé » : il retient ses gestes en conflit, dessine
`TaskProgress`, et relit sa liste quand l'opération finit sans lui.

`key` nomme la sorte d'opération. Deux opérations de même fonctionnalité,
espace, élément et clé ne tournent pas ensemble : la seconde rejette
`TaskError('conflict')` sans rien lancer.

## Quand la promesse rejette une `TaskError`

La promesse de `runTask` se résout et rejette comme le travail, sauf dans ces
cas, où elle rejette une `TaskError` dont la phrase dit déjà quoi faire
(`errorNote` la garde telle quelle) :

- `lost` : le serveur ne garde plus trace de l'opération. Il a redémarré, ou
  la page est revenue trop tard pour sa réponse. L'opération est dite
  interrompue, sauf si le serveur a pu dire sa fin entre-temps : la zone montre
  alors ce résultat ;
- `closed` : la connexion est tombée avant que la commande parte. Un travail
  local, lui, échoue vraiment avec sa connexion, et garde l'erreur d'origine ;
- `timeout` : la commande n'a pas pu partir en deux minutes ;
- `cancelled` : la personne a annulé. L'opération sort sans résultat, et
  l'appelant ne montre rien.

## Brancher une opération

```ts
await runTask(
    {
        feature: manifest.id,
        itemId: share.id,
        subject: share.name,
        key: 'snapshot.delete',
        title: 'Suppression du point de restauration',
        description: 'Les contenus que seul ce point gardait sont libérés.',
        done: 'Point de restauration supprimé.',
        failed: 'Suppression impossible.'
    },
    (task) => api.send('cloudSync.deleteSnapshot', { snapshotId }, task.sendOptions)
);
```

- `title` est un groupe nominal (« Suppression du… »), `subject` dit sur quoi :
  deux lignes de même titre se distinguent par lui.
- `done` est la phrase de succès de la zone, une chaîne ou une fonction du
  résultat. `failed` est le repli de la phrase d'échec, ou une fonction qui rend
  la note entière quand l'écran a déjà sa façon de dire un refus. Seules les
  chaînes voyagent : un autre onglet écrit « Terminé. » là où la phrase se
  calcule.
- L'écran garde sa logique après le `await` : relire sa liste, écrire sa note.
  Démonté, ces écritures ne font rien, et la zone porte le résultat.
- L'écran lit `useTasks` pour retenir ses gestes et dessiner `TaskProgress`.
- Côté serveur, le handler rapporte par `ctx.progress`. Sans rapport, la barre
  balaie sans rien promettre.
- Le serveur ne sait pas arrêter une commande : `cancel` ne s'offre qu'à un
  travail qui s'arrête de lui-même.

## Carte du code

| Fichier                                   | Rôle                                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client/src/stores/tasks.ts`              | le magasin : états, règle de fin, lectures (`foregroundOf`, `zoneOf`, `chipOf`, `matchRunning`), réconciliation avec ce que dit le serveur. Sans dépendance à Vite, testé sous Node |
| `client/src/sdk/tasks.ts`                 | `runTask` et `useTasks` : l'espace d'origine et la note d'échec résolus                                                                                                             |
| `client/src/api/ws.ts`                    | l'étiquette sur l'enveloppe, la requête qui survit à sa socket, `task.attach` à la réouverture, la sonde, les trames `task.*` de chaque instance                                    |
| `client/src/Components/TaskDialog/`       | `TasksHost`, monté une fois par l'accueil (le dialogue, l'annonce aux lecteurs d'écran, la garde de fermeture), `TaskDialog`, `TaskProgress`                                        |
| `client/src/Components/TopNavbar/`        | `TasksStatus` et `TaskChip` (la puce), `TasksPanel` et `TaskRow` (le panneau)                                                                                                       |
| `client/src/Components/Dialog/Dialog.tsx` | `appearDelayMs`, le délai d'apparition                                                                                                                                              |
| `src/Services/tasks.ts`                   | le registre : ouverture, annonce, réponse retenue, réclamation, retrait, bornes                                                                                                     |
| `src/ws/handler.ts`                       | la liste dans la trame `session`, l'ouverture après les gardes, la réponse confiée au registre                                                                                      |
| `src/ws/progress.ts`                      | le régulateur d'avancement, commun à une commande ordinaire et à une opération suivie                                                                                               |
| `src/features/task/`                      | `task.attach` et `task.dismiss`                                                                                                                                                     |
| `@deveye/types`                           | `protocol/envelope.ts` (l'étiquette), `domain/task.ts` (l'instantané, les trames, la liste), `features/task.ts` (les deux commandes)                                                |

Les essais et chaque état à plat sont dans la galerie de la page Tests et
débogage, section Retours, « Opérations longues » : les essais « suivis par le
serveur » lancent `debug.taskSample`, une commande lente qui ne fait rien.
