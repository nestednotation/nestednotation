var msg = qs["msg"];
var lblError = document.getElementById('alerts');
if (msg == "1"){
    lblError.innerText = "Session or password invalid";
}else if (msg == "2"){
    lblError.innerText = "Invalid session";
}else if (msg == "3"){
    lblError.innerText = "Username or password invalid";
}