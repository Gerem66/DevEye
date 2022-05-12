<?php

    $allFeatures = null;
    $allFeaturesTree = null;

    /**
     * @param DataBase $db
     * @return void Set the global variables $allFeatures and $allFeaturesTree
     */
    function DefineFeatures($db) {
        global $allFeatures, $allFeaturesTree;
        $allFeatures = $db->QueryArray('SELECT * FROM `Features`');
        $allFeaturesTree = array(
            'Admin' => array(
                'database',
                'logs'
            )
        );

        // Example (3 levels)
        /*$allFeaturesTree = array(
            'Admin' => array(
                'database',
                'logs',
                'logs' => array(
                    'logs',
                    'logs' => array(
                        'logs',
                        'logs'
                    ),
                    'logs'
                )
            )
        );*/
    }

    /**
     * @param string $id
     * @return Feature|null Returns the feature with the given ID, null otherwise
     */
    function GetFeatureByID($id) {
        global $allFeatures;
        if ($allFeatures === null) {
            return null;
        }
        for ($i = 0; $i < count($allFeatures); $i++) {
            if ($allFeatures[$i]['ID'] === $id) {
                return Feature::Load($allFeatures[$i]);
            }
        }
        return null;
    }

    function GenerateSidebar($featuresTree = null, $categoryName = null, $depth = 0) {
        global $allFeaturesTree;

        if ($featuresTree === null) {
            $featuresTree = $allFeaturesTree;
        }

        $content = '';
        foreach ($featuresTree as $key => $value) {
            $keyType = gettype($key);
            if ($keyType === 'integer') {
                // New feature or subfeature (button)
                $feature = GetFeatureByID($value);
                if ($feature === null) continue;
                if ($depth === 0 || $depth === 1) {
                    $content .= AddButtonFeature($feature, $categoryName);
                } else {
                    $content .= AddButtonSubFeature($feature, $categoryName);
                }
            } else {
                // New category (ul/li)
                if ($depth === 0) {
                    $content .= OpenInstance($key);
                    $content .= GenerateSidebar($value, $key, $depth + 1);
                    $content .= CloseInstance();
                } else {
                    $feature = GetFeatureByID($key);
                    if ($feature === null) continue;
                    $content .= OpenGroupFeature($feature);
                    $content .= GenerateSidebar($value, $key, $depth + 1);
                    $content .= CloseGroupFeature();
                }
            }
        }
        return $content;
    }



    ///// HTML Functions /////



    function OpenInstance($name) {
        return "<li class='instance'>
                    <p>$name</p>
                    <ul>";
    }
    function CloseInstance() {
        return '</ul></li>';
    }

    /**
     * @param Feature $feature
     * @param string $categoryName
     */
    function AddButtonFeature($feature, $categoryName) {
        $data_page = '';
        if ($feature->Redirect !== '') {
            $data_page = " data-category=\"$categoryName\" data-page=\"{$feature->Redirect}\"";
        }
        return "<li class='feature' name='sidebar-item'$data_page>
                    <a class='title-item'>
                        <span class='icon icon-{$feature->Icon}'></span>
                        <p>{$feature->Name}</p>
                    </a>
                </li>";
    }

    /**
     * @param Feature $feature
     */
    function OpenGroupFeature($feature) {
        return "<li class='group-feature' name='sidebar-group'>
                    <a class='title-item'>
                        <span class='icon icon-{$feature->Icon}'></span>
                        <p>{$feature->Name}</p>
                        <span class='icon icon-chevron'></span>
                    </a>
                    <ul>";
    }
    function CloseGroupFeature() {
        return '</ul></li>';
    }

    /**
     * @param Feature $feature
     * @param string $categoryName
     */
    function AddButtonSubFeature($feature, $categoryName) {
        $data_page = '';
        if ($feature->Redirect !== '') {
            $data_page = " data-category=\"$categoryName\" data-page=\"{$feature->Redirect}\"";
        }
        return "<li class='sub-feature' name='sidebar-item'$data_page>
                    <a>
                        <span class='icon icon-{$feature->Icon}'></span>
                        <p>{$feature->Name}</p>
                    </a>
                </li>";
    }

?>