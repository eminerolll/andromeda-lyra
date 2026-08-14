// public/ altindaki HTML sayfalarinin dosya adiyla dogrudan istenmesini
// engeller. Statik middleware auth kapilarindan ONCE calisiyor, bu yuzden
// "/index.html" panelin iskeletini oturum acmadan veriyordu: "/" requireAuth'a
// tabiyken "/index.html" serbest geciyordu, yani ayni sayfanin iki farkli
// kapisi vardi.
//
// Dogrudan erisimin mesru bir kullanimi yok — uc HTML'in de kendi route'u var:
//   "/"      -> public/index.html   (auth.requireAuth)
//   "/login" -> public/login.html   (routes/auth-routes.js)
//   "/"      -> public/setup.html   (yalnizca LYRA_SETUP_MODE=1 iken)
//
// Varliklar (css, js, font, ikon, brand) bilerek disarida: login sayfasi
// oturum acilmadan once onlari yukluyor, engellenirse giris ekrani cirilciplak
// kalir.
module.exports = function blockDirectHtml(req, res, next) {
  if (String(req.path).toLowerCase().endsWith(".html")) {
    return res.status(404).type("text/plain").send("Not found\n");
  }
  next();
};
