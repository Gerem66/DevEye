function Init_User() {
    let bt_show_passwords = document.getElementsByName('bt-show-password');
    for (let i = 0; i < bt_show_passwords.length; i++) {
        bt_show_passwords[i].onclick = () => SwitchPasswordVision(bt_show_passwords[i]);
    }

    let bt_open_changepwd = document.getElementById('bt-open-changepwd');
    let bt_open_quicklink = document.getElementById('bt-open-quicklink');
    bt_open_changepwd.onclick = OpenChangepasswordPopup;
}

function OpenChangepasswordPopup() {
    let popup = document.getElementById('popup-changepwd');
    popup.classList.add('active');

    let tb_password = document.getElementsByName('pwd')[0];
    let tb_new_password = document.getElementsByName('new-pwd')[0];
    let btn_save = document.getElementsByName('save')[0];
    let btn_back = document.getElementsByName('back')[0];
    tb_password.focus();

    function SavePassword() {
        btn_save.disabled = true;
        let password = tb_password.value;
        let new_password = tb_new_password.value;

        // Get quicklink
        let data = new FormData();
        data.append('changepassword', password);
        data.append('newpassword', new_password);
        params = { method: 'POST', body: data };
        fetch('./user', params)
            .then(function(res) { return res.text(); })
            .then(function(content) {
                if (content === "OK") {
                    tb_password.parentNode.parentNode.innerHTML = "<p>Mot de passe modifié avec succès !</p>";
                } else if (content == "WRONG") {
                    tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (Wrong password)</p>";
                } else {
                    tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (" + content + ")</p>";
                }
            })
            .catch(function(err) {
                tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (" + err + ")</p>";
            })
            .finally(function() {
                btn_save.remove();
                tb_new_password.parentNode.parentNode.remove();
                btn_back.onclick = () => LoadPage('user');
                popup.onclick = (e) => { if (e.target === popup) LoadPage('user'); }
            });
    }

    btn_save.onclick = SavePassword;
    btn_back.onclick = () => popup.classList.remove('active');
    popup.onclick = (e) => { if (e.target === popup) popup.classList.remove('active'); }
}