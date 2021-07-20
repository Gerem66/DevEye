<?php

    $key = 'Bj1<470L:Ddd;jO$';

    function OpenConnection() {
        $conn = new mysqli('localhost', 'u444572210_oxy_gerem', 'rL:X5gV+fWh1', 'u444572210_oxy');
        if ($conn->connect_error) {
            die('Connection failed: ' . $conn->connect_error);
        }
        return $conn;
    }

    function AddLog($UID, $description) {
        $conn = OpenConnection();
        $IP = GetIP();
        $conn->query("INSERT INTO `Logs` (`UID`, `IP`, `Description`) VALUES ('$UID', '$IP', '$description')");
        $conn->close();
    }

    function GetIP() {
        if (isset($_SERVER['HTTP_CLIENT_IP']))
            return $_SERVER['HTTP_CLIENT_IP'];
        elseif (isset($_SERVER['HTTP_X_FORWARDED_FOR']))
            return $_SERVER['HTTP_X_FORWARDED_FOR'];
        else
            return (isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '');
    }

    function Encrypt($str) {
        global $key;
        return openssl_encrypt($str, 'AES-128-ECB', $key);
    }

    function Decrypt($str) {
        global $key;
        return openssl_decrypt($str, 'AES-128-ECB', $key);
    }

    function GetRowContent($table, $cellSearch, $cellValue) {
        $conn = OpenConnection();
        $result = $conn->query("SELECT * FROM `u444572210_oxy`.`$table` WHERE `$cellSearch` = '$cellValue'")->fetch_assoc();
        $conn->close();
        return (isset($result)) ? $result : null;
    }

    function GetRowsContent($table, $cellSearch, $cellValue) {
        $rows = [];
        $conn = OpenConnection();
        $result = $conn->query("SELECT * FROM `u444572210_oxy`.`$table` WHERE `$cellSearch` = '$cellValue'");
        $conn->close();
        while ($row = $result->fetch_row()) {
            array_push($rows, $row);
        }
        return count($rows) > 0 ? $rows : null;
    }

    function GetCellContent($table, $cell, $id, $encrpyt = true) {
        $content = '';

        $conn = OpenConnection();
        $result = $conn->query("SELECT * FROM `u444572210_oxy`.`$table` WHERE ID = '$id'")->fetch_assoc();
        if ($conn && isset($result)) {
            $content = $encrpyt ? Decrypt($result[$cell]) : $result[$cell];
        }
        $conn->close();

        return $content;
    }

    function SaveCellContent($table, $cell, $id, $content, $encrpyt = true) {
        $conn = OpenConnection();
        if ($encrpyt) {
            $encrypted_content = $content != "" ? Encrypt($content) : '';
            $conn->query("UPDATE `$table` SET `$cell` = '$encrypted_content' WHERE ID = '$id'"); // Users / Instances
        } else {
            $conn->query("UPDATE `$table` SET `$cell` = '$content' WHERE ID = '$id'"); // Users / Instances
        }
        $conn->close();
    }

    function GetMembersLength($instanceID) {
        $length = 0;

        $conn = OpenConnection();
        $result = $conn->query("SELECT ID FROM `Users` WHERE `InstanceID` = '$instanceID'");
        $conn->close();
        if (isset($result)) {
            $length = $result->num_rows;
        }

        return $length;
    }

?>