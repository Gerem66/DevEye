<?php

    class WSSConfig
    {
        /**
         * Show debug messages.\
         * 0 = none\
         * 1 = errors only,\
         * 2 = errors, warnings and debug messages,\
         * 3 = all, with client messages, etc.
         * @var int $isDebug
         */
        public static $isDebug = 3;

        /**
         * Maximal number of clients. New clients will be rejected.\
         * Set to 0 to disable the limit.
         * @var int $maxClients
         */
        public static $maxClients = 3;

        /**
         * Maximal number of messages per client.\
         * Set to 0 to disable the limit.
         * @var int $maxAttemptsPerMinute
         */
        public static $maxAttemptsPerMinute = 3;
    }

?>