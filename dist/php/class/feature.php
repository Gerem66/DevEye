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
        }

        /**
         * @param array $feature Contains all feature information
         * @return Feature|null Returns the feature if it contains correct data, null otherwise
         */
        public static function Load($feature) {
            try {
                $feature = new Feature($feature);
                return $feature;
            } catch (Exception $e) {
                return null;
            }
        }

        /**
         * @param array $arr Contains all feature information
         * @return bool True if the feature contains correct data, false otherwise
         */
        private function isValid($arr) {
            $vars = array_keys(get_object_vars($this));
            foreach ($vars as $var) {
                if (!array_key_exists($var, $arr)) {
                    return false;
                }
            }
            return true;
        }
    }

?>