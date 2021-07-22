function OpenEditPopup() {
    let popup = document.getElementById('popup-mail');
    popup.classList.add('active');

    let btn_save = document.getElementsByName('save')[0];
    let btn_back = document.getElementsByName('back')[0];

    btn_save.onclick = () => { __SaveMail(0); };
    btn_back.onclick = () => popup.classList.remove('active');
    popup.onclick = (e) => { if (e.target === popup) popup.classList.remove('active'); }
}

function OpenCreatePopup() {
    let popup = document.getElementById('popup-mail-create');
    popup.classList.add('active');

    let btn_save = document.getElementsByName('save')[1];
    let btn_back = document.getElementsByName('back')[1];

    btn_save.onclick = () => { __SaveMail(1); };
    btn_back.onclick = () => popup.classList.remove('active');
    popup.onclick = (e) => { if (e.target === popup) popup.classList.remove('active'); }
}

function __SaveMail(index) {
    PreLoadPage();
    document.getElementById('popup-mail').classList.remove('active');
    document.getElementById('popup-mail-create').classList.remove('active');

    let value_id = document.getElementsByName('tb_id')[index].value.toString();
    let value_title = document.getElementsByName('tb_title')[index].value.toString();
    let value_server = document.getElementsByName('tb_server')[index].value.toString();
    let value_mail = document.getElementsByName('tb_mail')[index].value.toString();
    let value_password = document.getElementsByName('tb_password')[index].value.toString();
    let value_color = document.getElementsByName('tb_color')[index].value.toString();

    let data = new FormData();
    data.append('save', value_id);
    data.append('value_title', value_title);
    data.append('value_server', value_server);
    data.append('value_mail', value_mail);
    data.append('value_password', value_password);
    data.append('value_color', value_color);

    params = {
        method: 'POST',
        body: data
    };
    fetch('./mails', params)
    .then(function(res){ return res.text(); })
    .then(function(data){ LoadPage('mails', { 'id': value_id }); })
}

function Delete() {
    PreLoadPage();
    let value_id = document.getElementsByName('tb_id')[0].value.toString();

    let data = new FormData();
    data.append('delete', value_id);

    params = {
        method: 'POST',
        body: data
    };
    fetch('./mails', params)
    .then(function(res){ return res.text(); })
    .then(function(data){ LoadPage('mails'); })
}

function OpenMail(boxIndex, mail, folder) {
    let popup = document.getElementById('popup-mail-read');
    AsyncLoad();

    let label_subject = document.getElementById('mail-read-subject');
    let label_from = document.getElementById('mail-read-from');
    let label_body = document.getElementById('mail-read-body');
    let label_date = document.getElementById('mail-read-date');

    let mid = mail.getElementsByTagName('input')[0].value;
    mail.style.background = 'none'; // Mark as read
    label_subject.textContent = mail.getElementsByTagName('input')[1].value;
    label_from.textContent = 'De: ' + mail.getElementsByTagName('input')[2].value;
    label_date.textContent = mail.getElementsByTagName('input')[3].value;

    let data = new FormData();
    data.append('id', boxIndex);
    data.append('folder', folder);
    data.append('read', mid);

    params = { method: 'POST', body: data };
    fetch('./mails', params)
    .then((res) => { return res.text(); })
    .then((data) => {
        label_body.innerHTML = data;
        AsyncLoaded();
        popup.classList.add('active');
    });

    document.getElementById('mail-read-delete').onclick = () => {
        CloseMail();
        setTimeout(() => { RemoveMail(boxIndex, mid); }, 300);
    }
    document.getElementById('mail-read-back').onclick = () => CloseMail();
    popup.onclick = (e) => { if (e.target === popup) CloseMail(); }
}
function CloseMail() {
    document.getElementById('popup-mail-read').classList.remove('active');
    setTimeout(() => {
        document.getElementById('mail-read-body').innerHTML = '';
    }, 100);
}

function ChangeView(id, index, folder = '') {
    LoadPage('mails', { id: id, 'view': index, 'folder': folder });
}

function SwitchSelection() {
    let buttons = document.getElementsByName('checkall');
    let mails = document.getElementsByName('mail-check');

    let currChecked = buttons[0].getElementsByTagName('input')[0].checked;

    buttons[0].getElementsByTagName('input')[0].checked = !currChecked;
    buttons[1].getElementsByTagName('input')[0].checked = !currChecked;
    for (let i = 0; i < mails.length; i++) mails[i].checked = !currChecked;
}

function SetServer(index, txt = '') {
    let tb_server = document.getElementsByName('tb_server')[index];
    tb_server.value = txt;
}

function RemoveMail(curr_account, index, folder) {
    let uidToDelete = GetSelectedMails(index);

    if (uidToDelete.length > 0) {
        let toDelete = uidToDelete.join(',');
        LoadPage('mails', { 'id': curr_account, 'folder': folder, 'expunge': toDelete });
    }
}

function SetMailsFlag(curr_account, index, folder, set = true) {
    let uidToDelete = GetSelectedMails(index);

    if (uidToDelete.length > 0) {
        let toDelete = uidToDelete.join(',');
        if (set) LoadPage('mails', { 'id': curr_account, 'folder': folder, 'seen': toDelete });
        else LoadPage('mails', { 'id': curr_account, 'folder': folder, 'unseen': toDelete });
    }
}

function SetMailsFav(curr_account, index, folder, set = true) {
    let uidToDelete = GetSelectedMails(index);

    if (uidToDelete.length > 0) {
        let toDelete = uidToDelete.join(',');
        if (set) LoadPage('mails', { 'id': curr_account, 'folder': folder, 'fav': toDelete });
        else LoadPage('mails', { 'id': curr_account, 'folder': folder, 'unfav': toDelete });
    }
}

function GetSelectedMails(index) {
    let uidToDelete = [];

    if (index == -1) { // Selection
        let mails = document.getElementsByName('mail-check');
        for (let i = 0; i < mails.length; i++) {
            if (mails[i].checked) {
                uidToDelete.push(mails[i].value);
            }
        }
    } else {
        uidToDelete.push(index);
    }

    return uidToDelete;
}

function SwitchPasswordVision(element) {
    let parent = element.parentNode.parentNode;
    let input = parent.getElementsByTagName('input')[0];
    let icon = element.getElementsByTagName('i')[0];
    let hidded = input.type == 'password';

    input.type = hidded ? 'text' : 'password';
    icon.classList.remove('fa-eye-slash');
    icon.classList.remove('fa-eye');
    icon.classList.add(hidded ? 'fa-eye' : 'fa-eye-slash')
}