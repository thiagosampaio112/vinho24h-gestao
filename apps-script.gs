/**
 * ==========================================================================
 *  VINHO 24 HORAS · GESTÃO — Backend (Google Apps Script)
 * ==========================================================================
 *
 *  Este arquivo é o "mini-servidor" do app. Ele:
 *    • LÊ e ESCREVE na sua planilha nova (abas Estoque, Compras, Fornecedores);
 *    • (Fase 2) lê fotos/PDF de nota fiscal usando a IA (Claude).
 *
 *  COMO INSTALAR — passo a passo completo no arquivo SETUP.md.
 *  Resumo:
 *    1) Crie a planilha nova com as 3 abas (o SETUP tem os cabeçalhos prontos).
 *    2) Nessa planilha: Extensões → Apps Script. Apague o exemplo e cole ISTO.
 *    3) Em "Configurações do projeto" → Propriedades do script, crie:
 *          TOKEN          = uma senha qualquer (a MESMA que você põe no app.js)
 *          CLAUDE_API_KEY = sua chave da API do Claude   (só na Fase 2)
 *    4) Implantar → Nova implantação → App da Web:
 *          Executar como: Eu   |   Quem pode acessar: Qualquer pessoa
 *       Copie o link que termina em /exec e cole em API_URL no app.js.
 * ==========================================================================
 */

// Nomes das abas (mude aqui se quiser outros nomes na planilha).
var ABA_ESTOQUE = "Estoque";
var ABA_COMPRAS = "Compras";
var ABA_FORNECEDORES = "Fornecedores";

// Colunas de cada aba (a ORDEM tem que bater com a 1ª linha da planilha).
var COL_ESTOQUE = ["sku","nome","tipo","uva","produtor","qtd","minimo","precoAquisicao","fornecedor","dataCompra","obs"];
var COL_COMPRAS = ["data","nome","qtd","precoUnit","fornecedor","notaChave"];
var COL_FORNECEDORES = ["nome","contato","obs"];

// ---------------------------------------------------------------- utilidades
function _prop(nome) { return PropertiesService.getScriptProperties().getProperty(nome) || ""; }
function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function _checaToken(token) {
  var esperado = _prop("TOKEN");
  if (esperado && token !== esperado) throw new Error("Token inválido");
}
function _aba(nome, colunas) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(nome);
  if (!sh) { sh = ss.insertSheet(nome); sh.appendRow(colunas); }
  return sh;
}
function _num(x) { var n = parseFloat(String(x).replace(",", ".")); return isNaN(n) ? 0 : n; }

// Lê uma aba inteira como lista de objetos (usando a 1ª linha como cabeçalho).
function _lerAba(nome, colunas) {
  var sh = _aba(nome, colunas);
  var valores = sh.getDataRange().getValues();
  if (valores.length < 2) return [];
  var cab = valores[0].map(function (c) { return String(c).trim(); });
  var out = [];
  for (var i = 1; i < valores.length; i++) {
    var linha = valores[i];
    if (linha.every(function (c) { return c === "" || c === null; })) continue;
    var obj = {};
    for (var j = 0; j < cab.length; j++) obj[cab[j]] = linha[j];
    out.push(obj);
  }
  return out;
}

// Encontra o número da linha (na planilha) de um item pelo SKU.
function _acharLinha(sh, sku) {
  var col = COL_ESTOQUE.indexOf("sku") + 1;
  var valores = sh.getRange(2, col, Math.max(0, sh.getLastRow() - 1), 1).getValues();
  for (var i = 0; i < valores.length; i++) if (String(valores[i][0]) === String(sku)) return i + 2;
  return -1;
}

function _objParaLinha(obj, colunas) { return colunas.map(function (c) { return obj[c] != null ? obj[c] : ""; }); }

// ------------------------------------------------------------------- LEITURA
function doGet(e) {
  try {
    _checaToken(e && e.parameter ? e.parameter.token : "");
    var estoque = _lerAba(ABA_ESTOQUE, COL_ESTOQUE).map(function (r) {
      r.qtd = _num(r.qtd); r.minimo = _num(r.minimo); r.precoAquisicao = _num(r.precoAquisicao);
      if (r.dataCompra instanceof Date) r.dataCompra = Utilities.formatDate(r.dataCompra, "GMT", "yyyy-MM-dd");
      return r;
    });
    var compras = _lerAba(ABA_COMPRAS, COL_COMPRAS).map(function (r) {
      r.qtd = _num(r.qtd); r.precoUnit = _num(r.precoUnit);
      if (r.data instanceof Date) r.data = Utilities.formatDate(r.data, "GMT", "yyyy-MM-dd");
      return r;
    }).reverse(); // mais recentes primeiro
    var fornecedores = _lerAba(ABA_FORNECEDORES, COL_FORNECEDORES);
    return _json({ estoque: estoque, compras: compras, fornecedores: fornecedores });
  } catch (err) {
    return _json({ erro: String(err.message || err) });
  }
}

// ------------------------------------------------------------------- ESCRITA
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    _checaToken(body.token);
    var r;
    switch (body.action) {
      case "salvarItem":       r = salvarItem(body.item, body.skuOriginal); break;
      case "excluirItem":      r = excluirItem(body.sku); break;
      case "ajustarQtd":       r = ajustarQtd(body.sku, body.qtd); break;
      case "registrarCompra":  r = registrarCompra(body.compra); break;
      case "lerNota":          r = lerNota(body.arquivoBase64, body.mime); break;
      default: throw new Error("Ação desconhecida: " + body.action);
    }
    return _json(r || { ok: true });
  } catch (err) {
    return _json({ erro: String(err.message || err) });
  }
}

function salvarItem(item, skuOriginal) {
  var sh = _aba(ABA_ESTOQUE, COL_ESTOQUE);
  var alvo = skuOriginal || item.sku;
  var linha = _acharLinha(sh, alvo);
  if (linha > 0) sh.getRange(linha, 1, 1, COL_ESTOQUE.length).setValues([_objParaLinha(item, COL_ESTOQUE)]);
  else sh.appendRow(_objParaLinha(item, COL_ESTOQUE));
  _garanteFornecedor(item.fornecedor);
  return { ok: true };
}

function excluirItem(sku) {
  var sh = _aba(ABA_ESTOQUE, COL_ESTOQUE);
  var linha = _acharLinha(sh, sku);
  if (linha > 0) sh.deleteRow(linha);
  return { ok: true };
}

function ajustarQtd(sku, qtd) {
  var sh = _aba(ABA_ESTOQUE, COL_ESTOQUE);
  var linha = _acharLinha(sh, sku);
  if (linha < 0) throw new Error("Item não encontrado: " + sku);
  var col = COL_ESTOQUE.indexOf("qtd") + 1;
  sh.getRange(linha, col).setValue(Math.max(0, _num(qtd)));
  return { ok: true };
}

function registrarCompra(compra) {
  var sh = _aba(ABA_COMPRAS, COL_COMPRAS);
  sh.appendRow(_objParaLinha(compra, COL_COMPRAS));
  // Atualiza o estoque: soma a quantidade e guarda último preço/fornecedor/data.
  var est = _aba(ABA_ESTOQUE, COL_ESTOQUE);
  var linha = _acharLinhaPorNome(est, compra.nome);
  if (linha > 0) {
    var qCol = COL_ESTOQUE.indexOf("qtd") + 1;
    var atual = _num(est.getRange(linha, qCol).getValue());
    est.getRange(linha, qCol).setValue(atual + _num(compra.qtd));
    if (compra.precoUnit) est.getRange(linha, COL_ESTOQUE.indexOf("precoAquisicao") + 1).setValue(_num(compra.precoUnit));
    if (compra.fornecedor) est.getRange(linha, COL_ESTOQUE.indexOf("fornecedor") + 1).setValue(compra.fornecedor);
    if (compra.data) est.getRange(linha, COL_ESTOQUE.indexOf("dataCompra") + 1).setValue(compra.data);
  } else {
    est.appendRow(_objParaLinha({
      sku: _slug(compra.nome), nome: compra.nome, tipo: "Tinto", uva: "", produtor: "",
      qtd: _num(compra.qtd), minimo: 3, precoAquisicao: _num(compra.precoUnit),
      fornecedor: compra.fornecedor || "", dataCompra: compra.data || "", obs: ""
    }, COL_ESTOQUE));
  }
  _garanteFornecedor(compra.fornecedor);
  return { ok: true };
}

function _acharLinhaPorNome(sh, nome) {
  var col = COL_ESTOQUE.indexOf("nome") + 1;
  var n = sh.getLastRow() - 1; if (n < 1) return -1;
  var valores = sh.getRange(2, col, n, 1).getValues();
  for (var i = 0; i < valores.length; i++)
    if (String(valores[i][0]).toLowerCase().trim() === String(nome).toLowerCase().trim()) return i + 2;
  return -1;
}

function _garanteFornecedor(nome) {
  nome = (nome || "").toString().trim(); if (!nome) return;
  var sh = _aba(ABA_FORNECEDORES, COL_FORNECEDORES);
  var lista = _lerAba(ABA_FORNECEDORES, COL_FORNECEDORES);
  if (!lista.some(function (f) { return String(f.nome).trim() === nome; })) sh.appendRow([nome, "", ""]);
}

function _slug(s) {
  return String(s || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "item";
}

/**
 * ==========================================================================
 *  FASE 2 — Leitura de nota fiscal por IA (Claude)
 * ==========================================================================
 *  Recebe a foto/PDF em base64, manda para o Claude e devolve os itens
 *  já organizados para o app mostrar (o usuário confere antes de salvar).
 *  Precisa da propriedade CLAUDE_API_KEY configurada no projeto.
 */
function lerNota(arquivoBase64, mime) {
  var apiKey = _prop("CLAUDE_API_KEY");
  if (!apiKey) throw new Error("Configure CLAUDE_API_KEY nas Propriedades do script (ver SETUP.md).");

  var ehPdf = (mime || "").indexOf("pdf") >= 0;
  var bloco = ehPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: arquivoBase64 } }
    : { type: "image", source: { type: "base64", media_type: mime || "image/jpeg", data: arquivoBase64 } };

  var instrucao =
    "Você recebe uma nota fiscal/cupom de compra de vinhos. Extraia os itens. " +
    "Responda SOMENTE com JSON válido, sem texto extra, no formato: " +
    '{"fornecedor":"","data":"AAAA-MM-DD","itens":[{"nome":"","qtd":0,"precoUnit":0}]}. ' +
    "Use ponto como separador decimal. Se não achar algum campo, deixe vazio ou 0.";

  var payload = {
    model: "claude-sonnet-5",
    max_tokens: 2000,
    messages: [{ role: "user", content: [bloco, { type: "text", text: instrucao }] }]
  };

  var resp = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var dados = JSON.parse(resp.getContentText());
  if (dados.error) throw new Error("IA: " + dados.error.message);
  var texto = (dados.content && dados.content[0] && dados.content[0].text) || "{}";
  texto = texto.replace(/```json|```/g, "").trim();
  var extraido = JSON.parse(texto);
  return { ok: true, nota: extraido };
}
