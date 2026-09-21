# Licences de DevEye

DevEye est un cœur libre, entouré d'un SDK permissif et de modules qui se
licencient comme leur auteur l'entend.

| Quoi                                                        | Licence                              |
| ----------------------------------------------------------- | ------------------------------------ |
| Ce dépôt : serveur, client, agent (`agent/`), `features/*`  | AGPL-3.0-only ([LICENSE](./LICENSE)) |
| `@deveye/types`, le SDK des modules                         | MIT                                  |
| `DevEye-Feature-Template`, le modèle d'un module            | MIT-0                                |
| Les modules distribués hors de ce dépôt (CloudSync, Audit…) | propriétaire, sur contrat            |

## Ce que l'AGPL vous demande

Installer DevEye, l'utiliser et le modifier pour vous ne vous oblige à rien.
Deux cas déclenchent une obligation :

- **vous distribuez** DevEye, modifié ou non : vous le faites sous AGPL-3.0,
  sources comprises ;
- **vous faites utiliser une version modifiée à travers le réseau** (article 13) :
  vous offrez à ses utilisateurs les sources de cette version.

Une organisation qui ne peut pas accepter ces termes peut obtenir une licence
commerciale auprès du titulaire des droits.

## Permission additionnelle : les modules

Accordée au titre de l'article 7 de l'AGPL-3.0.

Un **module** est un programme qui ne s'appuie sur DevEye qu'à travers
l'interface publique des modules : le paquet `@deveye/types` et le barrel
`deveye-sdk-client` que l'app fournit à l'exécution.

Le titulaire des droits vous autorise à charger un tel module dans DevEye, à
l'empaqueter avec lui et à distribuer l'ensemble, sans que l'AGPL s'étende au
module : il reste sous les termes que choisit son auteur, propriétaires compris.

La permission ne couvre ni une modification de DevEye lui-même, ni un module qui
importe le code interne de l'app par un autre chemin que le SDK. Ceux-là relèvent
de l'AGPL-3.0, comme les modules de `features/`.

## La marque

Le nom « DevEye » et son logo ne sont pas couverts par la licence. Une version
modifiée que vous distribuez ou que vous exploitez pour des tiers porte un autre
nom.

## Contribuer

Le cœur se double d'une licence commerciale, ce qui suppose un titulaire unique
des droits. Une contribution externe n'est fusionnée qu'une fois signé l'accord
de contribution, [CLA.md](./CLA.md) : vous gardez la propriété de votre travail
et concédez au titulaire le droit de le distribuer sous d'autres termes. La
signature se fait d'un commentaire sur la pull request.
