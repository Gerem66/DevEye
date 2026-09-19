-- Une ville reglee sur un fournisseur a cle, dans un espace qui n'en tient pas la
-- cle, repasse sur le fournisseur libre plutot que de rester muette : c'est ce
-- que fait desormais le retrait d'une cle. Chaque colonne est comparee a un
-- litteral, jamais a celle de l'autre table : les deux n'ont pas forcement la
-- meme collation.
UPDATE weather_locations l
SET l.provider = 'open-meteo'
WHERE l.provider = 'openweathermap'
  AND NOT EXISTS (
      SELECT 1 FROM weather_provider_keys k
      WHERE k.workspace_id = l.workspace_id AND k.provider = 'openweathermap'
  );
