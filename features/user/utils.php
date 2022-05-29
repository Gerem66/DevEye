<?php

    function GetTFA($tfa) {
        if ($tfa === null) {
            return "Désactivé<img src='./assets/icons/error.svg' alt='Error icon'></img>";
        }
        return "<a id='delete-tfa'>Supprimer</a>Activé<img src='./assets/icons/success.svg' alt='Success icon'></img>";
    }

    /** @param Feature $feature */
    function AddFeature($feature, $enabled = true) {
        $class = $enabled ? '' : ' class="disabled"';
        $icon = $enabled ? 'open' : 'close';
        return "<li data-id=\"{$feature->ID}\"$class>
                    <span class=\"icon icon-drag\" title=\"Déplacer la fonctionnalité\"></span>
                    <p>{$feature->Name}</p>
                    <span class=\"icon icon-eye-$icon\" title=\"Activer ou désactiver la fonctionnalité\"></span>
                </li>";
    }

    /** @param Feature $feature */
    function AddFeatureOption($feature, $default = false) {
        $selected = $default ? ' selected' : '';
        return "<option value='{$feature->ID}'$selected>{$feature->Name}</option>";
    }

    /**
     * @param Feature[] $features
     * @param User $user
     * @param array $tree
     * @param int $level
     * @return string Return HTML elements of all features
     */
    function DefineFeatures($features, $user, $tree, $level = 0) {
        $featuresHTML = '';
        foreach ($tree as $key => $value) {
            $keyType = gettype($key);
            if ($keyType === 'string') {
                $featuresHTML .= DefineFeatures($features, $user, $value, $level + 1);
            } else if ($keyType === 'integer') {
                $feature = Feature::GetFeatureByID($value, $features);
                if ($feature === null) continue;
                $featureEnabled = $feature->EnabledDefault;
                if (array_key_exists($feature->ID, $user->Settings)) {
                    $featureEnabled = $user->Settings[$feature->ID];
                }
                $featuresHTML .= AddFeature($feature, $featureEnabled);
            }
        }
        return $featuresHTML;
    }

    /**
     * @param Feature[] $features
     * @param User $user
     * @param array $tree
     * @param int $level
     * @return string Return HTML elements of all features
     */
    function DefineOptions($features, $user, $tree, $level = 0) {
        $featuresHTML = '';
        foreach ($tree as $key => $value) {
            $keyType = gettype($key);
            if ($keyType === 'string') {
                $featuresHTML .= DefineOptions($features, $user, $value, $level + 1);
            } else if ($keyType === 'integer') {
                $feature = Feature::GetFeatureByID($value, $features);
                if ($feature === null) continue;
                $featureEnabled = $feature->Enabled;
                if (array_key_exists($feature->ID, $user->Settings)) {
                    $featureEnabled = $user->Settings[$feature->ID];
                }
                $default = array_key_exists('default', $user->Settings) && $user->Settings['default'] == $feature->ID;
                if ($featureEnabled) {
                    $featuresHTML .= AddFeatureOption($feature, $default);
                }
            }
        }
        return $featuresHTML;
    }

?>