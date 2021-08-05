<?php

    class DataBase {
        function __construct($openConnection = true, $credentials = NULL) {
            $this->key = 'Bj1<470L:Ddd;jO$';
            $this->conn = NULL;
            if ($openConnection) $this->OpenConnection($credentials);
        }

        function __destruct() {
            if ($this->conn != NULL) {
                $this->conn->close();
            }
        }

        function OpenConnection($credentials = NULL) {
            if ($credentials != NULL && count($credentials) != 4) {
                die('Wrong database credentials');
            }

            if ($credentials == NULL) {
                $db_host = 'localhost';
                $db_name = 'u444572210_oxy';
                $db_user = 'u444572210_oxy_gerem';
                $db_pass = 'rL:X5gV+fWh1';
            } else {
                $db_host = $credentials[0];
                $db_name = $credentials[1];
                $db_user = $credentials[2];
                $db_pass = $credentials[3];
            }

            $this->conn = new mysqli($db_host, $db_user, $db_pass, $db_name);
            if ($conn->connect_error) {
                die('Connection failed: ' . $conn->connect_error);
            }
        }

        function query($query) {
            return $this->conn->query($query);
        }

        function Encrypt($str) {
            $output = "";
            if ($str) $output = openssl_encrypt($str, 'AES-128-ECB', $this->key);
            return $output;
        }
    
        function Decrypt($str) {
            $output = "";
            if ($str) $output = openssl_decrypt($str, 'AES-128-ECB', $this->key);
            return $output;
        }

        function GetRowContent($table, $cellSearch, $cellValue) {
            $result = $this->query("SELECT * FROM `u444572210_oxy`.`$table` WHERE `$cellSearch` = '$cellValue'")->fetch_assoc();
            return (isset($result)) ? $result : null;
        }

        function GetRowsContent($table, $cellSearch, $cellValue) {
            $rows = [];
            $result = $this->query("SELECT * FROM `u444572210_oxy`.`$table` WHERE `$cellSearch` = '$cellValue'");
            while ($row = $result->fetch_row()) {
                array_push($rows, $row);
            }
            return count($rows) > 0 ? $rows : null;
        }

        function GetCellContent($table, $cell, $id, $encrpyt = true) {
            $content = '';
            $result = $this->query("SELECT * FROM `u444572210_oxy`.`$table` WHERE ID = '$id'")->fetch_assoc();
            if (isset($result)) {
                $content = $encrpyt ? $this->Decrypt($result[$cell]) : $result[$cell];
            }
            return $content;
        }

        function SaveCellContent($table, $cell, $id, $content, $encrpyt = true) {
            if ($encrpyt) {
                $encrypted_content = $content != "" ? $this->Encrypt($content) : '';
                $this->query("UPDATE `$table` SET `$cell` = '$encrypted_content' WHERE ID = '$id'"); // Users / Instances
            } else {
                $this->query("UPDATE `$table` SET `$cell` = '$content' WHERE ID = '$id'"); // Users / Instances
            }
        }

        function RemoveRow($table, $id) {
            return $this->query("DELETE FROM `$table` WHERE ID = '$id'");
        }

    }

    function AddLog($UID, $description) {
        $db = new DataBase;
        $IP = GetIP();
        $db->query("INSERT INTO `Logs` (`UID`, `IP`, `Description`) VALUES ('$UID', '$IP', '$description')");
    }

    function GetIP() {
        if (isset($_SERVER['HTTP_CLIENT_IP']))
            return $_SERVER['HTTP_CLIENT_IP'];
        elseif (isset($_SERVER['HTTP_X_FORWARDED_FOR']))
            return $_SERVER['HTTP_X_FORWARDED_FOR'];
        else
            return (isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '');
    }

?>