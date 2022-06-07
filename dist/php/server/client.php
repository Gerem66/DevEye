<?php

    class Client
    {
        /** @var User $user */
        private $user = null;

        /** @var string $currentPage */
        private $currentPage = null;
        /** @var string $currentCategory */
        private $currentCategory = null;

        /** @var function $action */
        private $action = null;

        function __construct($UID, $socket) {
            $this->UID = $UID;
            $this->socket = $socket;
            $this->isConnected = false;
        }

        public function close() {
            if (!$this->isConnected) {
                return false;
            }
            $this->isConnected = false;
            return fclose($this->socket);
        }

        public function handshake() {
            $headers = fread($this->socket, 8192);
            if ($headers === false) {
                echo("Read failed\n");
                return false;
            }

            $secWebSocketKey = preg_match('/Sec-WebSocket-Key: (.*)\r\n/', $headers, $matches) ? $matches[1] : false;
            if ($secWebSocketKey === false) {
                return false;
            }

            $secWebSocketAccept = sha1($secWebSocketKey . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
            $secWebSocketAccept = pack('H*', $secWebSocketAccept);
            $secWebSocketAccept = base64_encode($secWebSocketAccept);
            $handshake = "HTTP/1.1 101 Switching Protocols\r\n" .
                "Upgrade: websocket\r\n" .
                "Connection: Upgrade\r\n" .
                "Sec-WebSocket-Accept: $secWebSocketAccept\r\n\r\n";
            $written = fwrite($this->socket, $handshake);
            if ($written) {
                $this->isConnected = true;
            }
        }

        public function receive($message) {
            global $db;

            $data = json_decode($message, true);
            if ($data === null) return false;

            if (!key_exists('type', $data)) {
                return false;
            }

            $type = $data['type'];
            switch ($type) {
                case 'connect': $this->connect($db, $data); break;
                case 'loadScripts': $this->loadScripts(); break;
                case 'loadStyles': $this->loadStyles(); break;
                case 'loadBody': $this->loadBody($db); break;
                case 'loadPage': $this->loadPage($data); break;
                case 'callAction': $this->callAction($db, $data['action']); break;

                default: return false;
            }

            return true;
        }

        /**
         * @param string $message
         * @return bool True if the message has been sent, false otherwise
         */
        public function send($message) {
            //$message = mask($message);
            $message = encodeFrame($message);

            if ($message === false) {
                echo('Mask failed');
                return false;
            }

            $written = fwrite($this->socket, $message);
            if ($written === false) {
                echo("Write failed\n");
                return false;
            }

            return true;
        }

        private function connect($db, $data) {
            $username = $data['username'];
            $password = $data['password'];
            if (!isset($username, $password)) {
                $this->send('error');
                return false;
            }

            $hashedPassword = $db->encryption->HashPassword($password);
            $rawUser = $db->GetRowContent('Users', 'Username', $username);
            $user = User::Load($rawUser, $hashedPassword);

            if ($user === null) {
                $db->AddLog(0, 'login', "User connection failed - User \"$username\" not found");
                $this->send('error');
                return false;
            }
    
            if (!password_verify($password, $user->Password)) {
                $db->AddLog($user->ID, 'login', 'User connection failed - wrong password');
                $this->send('error');
                return false;
            }
    
            $db->AddLog($user->ID, 'login', 'User connection successfully.');
            $this->user = $user;
            $this->send('ok');
        }

        private function loadScripts() {
            $scriptsIgnore = array(
                'deveye',
                'wss',
                'login',
                'functions',
                'main'
            );
            $content = GetScriptsFiles(__DIR__.'/../../js/', 'js', $scriptsIgnore);
            $content .= GetScriptsFiles(__DIR__.'/../../../features/', 'js');
            $this->send($content);
        }

        private function loadStyles() {
            $styleIgnore = array(
                'login',
                'icons',
                'fonts',
                'inputs',
                'loading'
            );
            $content = GetScriptsFiles(__DIR__.'/../../css/', 'css', $styleIgnore);
            $content .= GetScriptsFiles(__DIR__.'/../../../features/', 'css');
            $this->send($content);
        }

        private function loadBody($db) {
            // Load sidebar
            $sidebar = GenerateSidebar($db, $this->user);
        
            // Load default page
            if (array_key_exists('default', $this->user->Settings) && $this->user->Settings['default'] !== 'user') {
                $rawFeature = $db->GetRowContent('Features', 'ID', $this->user->Settings['default']);
                $feature = Feature::Load($rawFeature);
                $correctLevel = $feature->Level <= $this->user->Level;
                $enabled = $feature->EnabledDefault;
                if (array_key_exists($feature->ID, $this->user->Settings)) {
                    $enabled = $this->user->Settings[$feature->ID];
                }
                if ($feature !== null && $correctLevel && $enabled) {
                    // <script>page.defaultPage = '{$feature->Redirect}'</script>
                }
            }
            $variables = array(
                'version' => $GLOBALS['VERSION'],
                'avatar' => $this->user->Avatar,
                'username' => $this->user->Username,
                'sidebar' => $sidebar
            );
            $content = ImportHTML(__DIR__.'/../../html/home.html', $variables);
            $this->send($content);
        }

        private function loadPage($data) {
            $page = $data['page'];
            $category = $data['category'];
            $dirIndex = __DIR__."/../../../features/$page/index.php";

            if (!file_exists($dirIndex)) {
                $this->send('error');
                return false;
            }

            $this->currentPage = $page;
            $this->currentCategory = $category;

            // Features variables
            global $db, $features;
            $user = $this->user;
            $content = include($dirIndex);
            $this->send($content);

            if (isset($action)) {
                $this->action = $action;
            }
        }

        private function callAction($db, $actionData) {
            if ($this->action === null) {
                return;
            }
            if ($this->user === null || $this->currentPage === null) {
                return;
            }
            if (!array_key_exists('type', $actionData)) {
                return;
            }

            $type = $actionData['type'];
            $args = $actionData['args'] ?? null;
            if (!isset($type)) return;

            $response = ($this->action)($db, $this->user, $type, $args);
            $this->send($response);
        }
    }

?>