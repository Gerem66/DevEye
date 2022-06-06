<?php

    class Feature
    {
        /** @var string $ID */
        public $ID;

        /** @var string $Name */
        public $Name;

        /** @var string $Icon */
        public $Icon;

        /** @var string $Redirect */
        public $Redirect;

        /** @var int $Level */
        public $Level;

        /** @var bool $EnabledDefault */
        public $EnabledDefault;

        /**
         * @param array $feature Contains all feature information
         * @throws Exception If the feature contains incorrect data
         */
        public function __construct($feature) {
            if ($feature === null || !$this->isValid($feature)) {
                throw(new Exception('Invalid feature'));
            }
            $this->ID = $feature['ID'];
            $this->Name = $feature['Name'];
            $this->Icon = $feature['Icon'];
            $this->Redirect = $feature['Redirect'];
            $this->Level = intval($feature['Level']);
            $this->EnabledDefault = intval($feature['EnabledDefault']) !== 0;
        }

        /**
         * @param array $feature Contains all feature information
         * @return Feature|null Returns the feature if it contains correct data, null otherwise
         */
        public static function Load($feature) {
            try { return new Feature($feature); }
            catch (Exception $e) { return null; }
        }

        /**
         * @param array $arr Contains all feature information
         * @return bool True if the feature contains correct data, false otherwise
         */
        private function isValid($arr) {
            if (!$arr) return false;
            $vars = array_keys(get_object_vars($this));
            foreach ($vars as $var) {
                if (!array_key_exists($var, $arr)) {
                    return false;
                }
            }
            return true;
        }

        /**
         * @param string $id
         * @param Feature[] $features
         * @return Feature|null Returns the feature with the given ID, null otherwise
         */
        public static function GetFeatureByID($id, $features) {
            foreach ($features as $feature) {
                if ($feature->ID == $id) {
                    return $feature;
                }
            }
            return null;
        }

        /**
         * @param User $user
         * @param Feature[] $features
         * @param array $levels Key is the level, value is name of the level
         * @param bool $getAll If true, all features are returned, otherwise only enabled features are returned
         * @return array Return an array of all features
         */
        public static function GetTree($user, $features, $levels, $getAll = false) {
            $tree = array();
            $remainFeatures = $features;

            for ($i = count($levels) - 1; $i >= 0; $i--) {
                // Add all features in order of level
                $branch = array();
                foreach ($user->Settings as $id => $enabled) {
                    if ($id === 'default') continue;
                    $feature = Feature::GetFeatureByID(strval($id), $features);
                    $correctLevel = $feature->Level === $i && $feature->Level <= $user->Level;
                    if ($correctLevel && ($enabled || $getAll)) {
                        array_push($branch, $feature->ID);
                    }
                    $remainIndex = array_search($feature, $remainFeatures);
                    if ($remainIndex !== false) {
                        unset($remainFeatures[$remainIndex]);
                    }
                }
                // Add remaining features (if enabled by default)
                foreach ($remainFeatures as $feature) {
                    $correctLevel = $feature->Level === $i && $feature->Level <= $user->Level;
                    if ($correctLevel && ($feature->EnabledDefault || $getAll)) {
                        array_push($branch, $feature->ID);
                        $remainIndex = array_search($feature, $remainFeatures);
                        if ($remainIndex !== false) {
                            unset($remainFeatures[$remainIndex]);
                        }
                    }
                }
                // Add branch to tree
                if (count($branch) > 0) {
                    $tree[$levels[$i]] = $branch;
                }
            }

            return $tree;
        }
    }

?>