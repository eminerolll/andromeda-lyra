// `git status --porcelain` cikti ayristirmasi.
//
// Format sabit genisliktedir: [X][Y][bosluk][yol]
//   X = index (staged) durumu, Y = calisma agaci durumu
//   Ikisinden biri BOSLUK olabilir ve bu bilgi tasir:
//     "M  a.js"  -> staged degisiklik
//     " M a.js"  -> yalnizca calisma agacinda degisiklik
//     "MM a.js"  -> ikisi birden
//     "?? a.js"  -> takip edilmeyen
//
// Bu yuzden satir ASLA trim edilmemeli. Onceden routes/git.js ciktinin
// tamamina .trim() uyguluyordu; ilk satir bosluklaysa o bosluk siliniyor ve
// tum sutunlar bir kayiyordu:
//   " M src/cart.js" -> "M src/cart.js" -> yol "rc/cart.js" (ilk harf yendi)
//   ve X sutunu 'M' okundugu icin degisiklik "staged" sayiliyordu — panel
//   "1 staged" derken diff "Unstaged" gosteriyordu.

function parseLine(line) {
  if (!line || line.length < 4) return null;
  const x = line[0];
  const y = line[1];
  const file = line.slice(3);
  return {
    x,
    y,
    file,
    status: (x + y).trim(),
    untracked: x === "?",
    // Bosluk "bu katmanda degisiklik yok" demek.
    staged: x !== "?" && x !== " ",
    unstaged: x !== "?" && y !== " "
  };
}

// Ham porcelain ciktisini satirlara ayirir. Sondaki newline zararsiz (bos
// satirlar eleniyor) ama satir BASINDAKI bosluk korunmali.
function parse(raw) {
  return String(raw)
    .split("\n")
    .filter((l) => l.length > 0)
    .map(parseLine)
    .filter(Boolean);
}

// UI'in bekledigi {status, file} listesi.
function toFiles(raw) {
  return parse(raw).map((e) => ({ status: e.status, file: e.file }));
}

// Rozetlerde kullanilan sayimlar.
function counts(raw) {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const e of parse(raw)) {
    if (e.untracked) untracked++;
    else {
      if (e.staged) staged++;
      if (e.unstaged) unstaged++;
    }
  }
  return { staged, unstaged, untracked, total: staged + unstaged + untracked };
}

module.exports = { parse, parseLine, toFiles, counts };
