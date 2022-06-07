<?php

    /**
     * @var User $user
     * @var DataBase $db
     */

    /**
     * Function called to perform server side operations\
     * once the page is loaded (often user actions)
     * @param DataBase $db
     * @param User $user
     * @param string $type
     * @param array $args
     * @return string String returned to the client
     */
    $action = function($db, $user, $type, $args) {
        if ($type === 'php') {
            $code = $args['code'];
            $output = array(
                'status' => 'error',
                'result' => 'empty'
            );
    
            if ($user->Level >= 2) {
                $result = null;
                try {
                    $result = eval($code);
                    if ($result === null) {
                        $output['result'] = 'Failed to execute the code';
                    } else {
                        $output['result'] = $result;
                        $output['status'] = 'ok';
                    }
                } catch (ParseError $e) {
                    $output['result'] = $e->getMessage();
                } catch (Exception $e) {
                    $output['result'] = $e->getMessage();
                }
            } else {
                // TODO - Add cheat suspicion
            }
    
            return json_encode($output);
        }
    };

    $variables = array(
        'username' => $user->Username
    );
    return ImportHTML(__DIR__.'/index.html', $variables);

?>