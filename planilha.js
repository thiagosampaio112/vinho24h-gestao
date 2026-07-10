/* ==========================================================================
   VINHO 24 HORAS · GESTÃO — Leitor de planilhas (.xlsx / .csv)
   ==========================================================================

   O sistema da adega (AMLabs) exporta relatórios em Excel (.xlsx). Este módulo
   LÊ esses arquivos DENTRO do próprio app, sem depender de nenhuma biblioteca
   externa: o navegador do celular já sabe descompactar (.xlsx é um .zip) e ler
   XML nativamente. Também aceita .csv, caso você exporte assim.

   Ele reconhece sozinho dois relatórios:
     • PLANOGRAMA  ("posição atual") — o que está na adega agora + mínimos + preço
     • VENDAS      ("total de vendas por produto") — o que saiu no período

   Uso:
     const r = await lerPlanilha(file);
     // r = { tipo: "planograma"|"vendas"|"desconhecido", colunas:[...], itens:[...] }
   -------------------------------------------------------------------------- */

// --- Normalização de texto (para casar nomes de coluna sem depender de acento/caixa)
function _norm(s) {
  return String(s == null ? "" : s)
    .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
// Número aceitando tanto "59.9" (xlsx) quanto "1.234,56" (csv br).
function _numPlan(x) {
  if (typeof x === "number") return x;
  var s = String(x == null ? "" : x).trim();
  if (!s) return 0;
  if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", "."); // formato br
  var n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

// ======================================================================
//  LEITURA CRUA — devolve { colunas:[...], linhas:[ {coluna: valor} ] }
// ======================================================================
async function lerTabela(file) {
  var nome = (file.name || "").toLowerCase();
  if (nome.endsWith(".csv") || file.type === "text/csv") {
    return _tabelaDeCsv(await file.text());
  }
  // .xlsx (ou qualquer coisa: tentamos como xlsx)
  var buf = await file.arrayBuffer();
  return await _tabelaDeXlsx(buf);
}

// --- CSV (separador , ou ;) --------------------------------------------
function _tabelaDeCsv(texto) {
  var linhas = _parseCsv(texto);
  if (!linhas.length) return { colunas: [], linhas: [] };
  var colunas = linhas[0].map(function (c) { return String(c).trim(); });
  var out = [];
  for (var i = 1; i < linhas.length; i++) {
    var l = linhas[i];
    if (l.every(function (c) { return String(c).trim() === ""; })) continue;
    var obj = {};
    for (var j = 0; j < colunas.length; j++) obj[colunas[j]] = l[j] != null ? l[j] : "";
    out.push(obj);
  }
  return { colunas: colunas, linhas: out };
}
// Parser de CSV tolerante (aspas, vírgula ou ponto-e-vírgula).
function _parseCsv(texto) {
  var sep = (texto.split("\n")[0].split(";").length > texto.split("\n")[0].split(",").length) ? ";" : ",";
  var linhas = [], campo = "", linha = [], dentroAspas = false;
  for (var i = 0; i < texto.length; i++) {
    var c = texto[i];
    if (dentroAspas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else dentroAspas = false; }
      else campo += c;
    } else if (c === '"') dentroAspas = true;
    else if (c === sep) { linha.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      linha.push(campo); linhas.push(linha); linha = []; campo = "";
    } else campo += c;
  }
  if (campo !== "" || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

// --- XLSX: descompacta o zip nativamente e lê o XML -------------------
async function _tabelaDeXlsx(buf) {
  var arquivos = _lerZip(new Uint8Array(buf));           // { "xl/..xml": Uint8Array }
  var dec = new TextDecoder("utf-8");
  async function texto(caminho) {
    var bytes = arquivos[caminho];
    if (!bytes) return "";
    if (bytes.__deflate) bytes = await _inflateRaw(bytes.dados);
    return dec.decode(bytes);
  }
  // Strings compartilhadas (o Excel guarda os textos numa tabela à parte)
  var compartilhadas = _lerSharedStrings(await texto("xl/sharedStrings.xml"));
  // Primeira planilha (esses relatórios têm uma só)
  var caminhoSheet = Object.keys(arquivos).filter(function (n) {
    return /^xl\/worksheets\/sheet\d+\.xml$/i.test(n);
  }).sort()[0] || "xl/worksheets/sheet1.xml";
  return _lerSheet(await texto(caminhoSheet), compartilhadas);
}

// Descompacta o deflate cru (o que o zip usa) usando a API nativa do navegador.
async function _inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined")
    throw new Error("Este navegador não descompacta .xlsx — abra o app no Chrome do celular, ou exporte a planilha como .csv.");
  var ds = new DecompressionStream("deflate-raw");
  var stream = new Blob([bytes]).stream().pipeThrough(ds);
  var ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

// Lê o índice do .zip (diretório central) e devolve os bytes de cada arquivo
// interno — descomprimindo na hora só o que for pedido (marca __deflate).
function _lerZip(u8) {
  var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // Acha o "End Of Central Directory" (assinatura PK\05\06), do fim pro começo.
  var eocd = -1;
  for (var i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Arquivo .xlsx inválido (não é um zip).");
  var totalEntradas = dv.getUint16(eocd + 10, true);
  var inicioCD = dv.getUint32(eocd + 16, true);
  var arquivos = {};
  var p = inicioCD;
  for (var e = 0; e < totalEntradas; e++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break; // fim do diretório central
    var metodo = dv.getUint16(p + 10, true);
    var tamComp = dv.getUint32(p + 20, true);
    var nomeLen = dv.getUint16(p + 28, true);
    var extraLen = dv.getUint16(p + 30, true);
    var comentLen = dv.getUint16(p + 32, true);
    var offLocal = dv.getUint32(p + 42, true);
    var nome = _utf8(u8, p + 46, nomeLen);
    // No cabeçalho local, o tamanho do "extra" pode ser diferente do central.
    var nomeLenL = dv.getUint16(offLocal + 26, true);
    var extraLenL = dv.getUint16(offLocal + 28, true);
    var inicioDados = offLocal + 30 + nomeLenL + extraLenL;
    var dados = u8.subarray(inicioDados, inicioDados + tamComp);
    arquivos[nome] = (metodo === 0) ? dados : { __deflate: true, dados: dados };
    p += 46 + nomeLen + extraLen + comentLen;
  }
  return arquivos;
}
function _utf8(u8, off, len) { return new TextDecoder("utf-8").decode(u8.subarray(off, off + len)); }

// Tabela de textos do Excel: cada <si> pode ter vários <t> (texto rico) — junta.
function _lerSharedStrings(xml) {
  if (!xml) return [];
  var doc = new DOMParser().parseFromString(xml, "application/xml");
  var sis = doc.getElementsByTagNameNS("*", "si");
  var out = [];
  for (var i = 0; i < sis.length; i++) {
    var ts = sis[i].getElementsByTagNameNS("*", "t"), s = "";
    for (var j = 0; j < ts.length; j++) s += ts[j].textContent;
    out.push(s);
  }
  return out;
}

// Lê a planilha em si: 1ª linha = cabeçalho; demais viram objetos por coluna.
function _lerSheet(xml, compartilhadas) {
  var doc = new DOMParser().parseFromString(xml, "application/xml");
  var rows = doc.getElementsByTagNameNS("*", "row");
  var matriz = [];
  for (var i = 0; i < rows.length; i++) {
    var cs = rows[i].getElementsByTagNameNS("*", "c");
    var linha = [];
    for (var j = 0; j < cs.length; j++) {
      var c = cs[j];
      var ref = c.getAttribute("r") || "";
      var col = _colIndex(ref);
      var tipo = c.getAttribute("t");
      var valor = "";
      if (tipo === "inlineStr") {
        var isEl = c.getElementsByTagNameNS("*", "t");
        for (var k = 0; k < isEl.length; k++) valor += isEl[k].textContent;
      } else {
        var v = c.getElementsByTagNameNS("*", "v")[0];
        var bruto = v ? v.textContent : "";
        if (tipo === "s") valor = compartilhadas[parseInt(bruto, 10)] || "";
        else valor = bruto; // número ou string de fórmula
      }
      linha[col] = valor;
    }
    matriz.push(linha);
  }
  // Remove linhas totalmente vazias e monta objetos pelo cabeçalho.
  matriz = matriz.filter(function (l) { return l.some(function (c) { return String(c == null ? "" : c).trim() !== ""; }); });
  if (!matriz.length) return { colunas: [], linhas: [] };
  var colunas = matriz[0].map(function (c) { return String(c == null ? "" : c).trim(); });
  var out = [];
  for (var r = 1; r < matriz.length; r++) {
    var obj = {};
    for (var col2 = 0; col2 < colunas.length; col2++) {
      var nomeCol = colunas[col2]; if (!nomeCol) continue;
      obj[nomeCol] = matriz[r][col2] != null ? matriz[r][col2] : "";
    }
    out.push(obj);
  }
  return { colunas: colunas, linhas: out };
}
// "B7" -> 1 (índice 0-based da coluna).
function _colIndex(ref) {
  var m = String(ref).match(/^([A-Z]+)/i); if (!m) return 0;
  var letras = m[1].toUpperCase(), n = 0;
  for (var i = 0; i < letras.length; i++) n = n * 26 + (letras.charCodeAt(i) - 64);
  return n - 1;
}

// ======================================================================
//  INTERPRETAÇÃO — reconhece o relatório e devolve itens canônicos
// ======================================================================
// Acha o valor de uma linha por nome de coluna aproximado (ignora acento/caixa).
function _campo(linha, colunas, alternativas) {
  for (var a = 0; a < alternativas.length; a++) {
    var alvo = _norm(alternativas[a]);
    for (var c = 0; c < colunas.length; c++) {
      if (_norm(colunas[c]).indexOf(alvo) >= 0) return linha[colunas[c]];
    }
  }
  return "";
}

async function lerPlanilha(file) {
  var tab = await lerTabela(file);
  var cols = tab.colunas || [];
  var normCols = cols.map(_norm).join(" | ");

  var ehPlanograma = /quant\w* atual/.test(normCols) || (/descricao produto/.test(normCols) && /minimo critico/.test(normCols));
  var ehVendas = /qtd\w* vendida/.test(normCols) || /valor vendido/.test(normCols);

  if (ehPlanograma) {
    var itensP = tab.linhas.map(function (l) {
      return {
        codigo: String(_campo(l, cols, ["Código Produto", "Codigo Produto", "Código", "Codigo"])).trim(),
        codigoBarras: String(_campo(l, cols, ["Código de barras", "Codigo de barras", "Barras", "EAN"])).trim(),
        nome: String(_campo(l, cols, ["Descrição Produto", "Descricao Produto", "Descrição", "Descricao", "Produto"])).trim(),
        categoria: String(_campo(l, cols, ["Categoria produto", "Categoria"])).trim(),
        precoVenda: _numPlan(_campo(l, cols, ["Preço", "Preco"])),
        minimo: _numPlan(_campo(l, cols, ["Mínimo crítico", "Minimo critico", "Mínimo", "Minimo"])),
        nivelPar: _numPlan(_campo(l, cols, ["Nível de par", "Nivel de par", "Par"])),
        quantAtual: _numPlan(_campo(l, cols, ["Quant. atual", "Quant atual", "Quantidade atual", "Atual"])),
        tipoProduto: String(_campo(l, cols, ["Tipo do Produto", "Tipo"])).trim(),
      };
    }).filter(function (x) { return x.nome; });
    return { tipo: "planograma", colunas: cols, itens: itensP };
  }

  if (ehVendas) {
    var itensV = tab.linhas.map(function (l) {
      return {
        codigo: String(_campo(l, cols, ["Código", "Codigo"])).trim(),
        nome: String(_campo(l, cols, ["Descrição", "Descricao", "Produto"])).trim(),
        categoria: String(_campo(l, cols, ["Categoria"])).trim(),
        precoRef: _numPlan(_campo(l, cols, ["Preço de referência", "Preco de referencia", "Referência", "Referencia"])),
        precoMedio: _numPlan(_campo(l, cols, ["Preço médio", "Preco medio", "Médio", "Medio"])),
        qtd: _numPlan(_campo(l, cols, ["Qtd. vendida", "Qtd vendida", "Quantidade vendida", "Vendida", "Qtd"])),
        valorVendido: _numPlan(_campo(l, cols, ["Valor Vendido", "Valor vendido", "Total"])),
      };
    }).filter(function (x) { return x.nome && x.qtd > 0; });
    return { tipo: "vendas", colunas: cols, itens: itensV };
  }

  return { tipo: "desconhecido", colunas: cols, itens: [] };
}
