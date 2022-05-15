<?php

    /**
     * @param DataBase $db
     * @param User $user
     * @return string Get sidebar items content
     */
    function GenerateSidebar($db, $user) {
        function gen($features, $featuresTree, $categoryName = null, $depth = 0) {
            $content = '';
            foreach ($featuresTree as $key => $value) {
                $keyType = gettype($key);
                if ($keyType === 'integer') {
                    // New feature or subfeature (button)
                    $feature = Feature::GetFeatureByID($value, $features);
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
                        $content .= gen($features, $value, $key, $depth + 1);
                        $content .= CloseInstance();
                    } else {
                        $feature = Feature::GetFeatureByID($key, $features);
                        if ($feature === null) continue;
                        $content .= OpenGroupFeature($feature);
                        $content .= gen($features, $value, $key, $depth + 1);
                        $content .= CloseGroupFeature();
                    }
                }
            }
            return $content;
        }

        $rawFeatures = $db->QueryArray("SELECT * FROM `Features` WHERE `Level` <= {$user->Level}");
        $features = array_map(fn($f) => Feature::Load($f), $rawFeatures);
        $tree = Feature::GetTree($user, $features, $GLOBALS['LEVEL_TEXTS']);
        return gen($features, $tree);
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