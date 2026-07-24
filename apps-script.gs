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
var ABA_PRECOS = "Precos";       // Fase 3B: histórico do menor preço público achado por vinho
var ABA_LOJAS = "Lojas";         // Fase 3B: lojas de confiança extras (além do Buscapé)
var ABA_PDVS = "Pdvs";           // Fase 4: pontos de venda (adegas)
var ABA_PDV_ESTOQUE = "PdvEstoque"; // Fase 4: quantidade de cada rótulo em cada adega
var ABA_VENDAS = "Vendas";       // Fase 4: histórico de vendas por período (giro)

// Colunas de cada aba. As colunas novas da Fase 4 (codigo, codigoBarras, categoria,
// precoVenda) ficam NO FIM da lista do estoque — assim o "auto-heal" só as ACRESCENTA
// à planilha antiga, sem bagunçar a ordem das colunas que já existiam.
var COL_ESTOQUE = ["sku","nome","tipo","uva","produtor","qtd","minimo","precoAquisicao","fornecedor","dataCompra","obs","codigo","codigoBarras","categoria","precoVenda"];
var COL_COMPRAS = ["data","nome","qtd","precoUnit","fornecedor","notaChave"];
var COL_FORNECEDORES = ["nome","contato","obs"];
var COL_PRECOS = ["data","consulta","achado","preco","url","site"];
var COL_LOJAS = ["nome","url","ativo"];
var COL_PDVS = ["nome","ativo","obs"];
var COL_PDV_ESTOQUE = ["pdv","sku","qtd","minimo","nivelPar","precoVenda"];
var COL_VENDAS = ["periodoInicio","periodoFim","importadoEm","pdv","sku","codigo","descricao","categoria","qtd","precoMedio","valorVendido"];

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
  if (!sh) { sh = ss.insertSheet(nome); sh.appendRow(colunas); return sh; }
  // Auto-heal: garante que o cabeçalho tenha TODAS as colunas esperadas. Colunas
  // que faltam (ex.: novas da Fase 4) são acrescentadas ao FIM, sem apagar dados.
  if (colunas && colunas.length) {
    var lastCol = sh.getLastColumn();
    var header = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (c) { return String(c).trim(); }) : [];
    var faltando = colunas.filter(function (c) { return header.indexOf(c) < 0; });
    if (faltando.length) sh.getRange(1, header.length + 1, 1, faltando.length).setValues([faltando]);
  }
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
    obj.__row = i + 1; // nº real da linha na planilha (para editar/excluir com precisão)
    out.push(obj);
  }
  return out;
}

// Encontra o número da linha (na planilha) de um item pelo SKU.
function _acharLinha(sh, sku) {
  var col = COL_ESTOQUE.indexOf("sku") + 1;
  var n = sh.getLastRow() - 1;
  if (n < 1) return -1; // aba só com cabeçalho (ou vazia): nada a procurar
  var valores = sh.getRange(2, col, n, 1).getValues();
  for (var i = 0; i < valores.length; i++) if (String(valores[i][0]) === String(sku)) return i + 2;
  return -1;
}

function _objParaLinha(obj, colunas) { return colunas.map(function (c) { return obj[c] != null ? obj[c] : ""; }); }

// ------------------------------------------------------------------- LEITURA
function doGet(e) {
  try {
    _checaToken(e && e.parameter ? e.parameter.token : "");
    var estoque = _lerAba(ABA_ESTOQUE, COL_ESTOQUE).map(function (r) {
      r.qtd = _num(r.qtd); r.minimo = _num(r.minimo); r.precoAquisicao = _num(r.precoAquisicao); r.precoVenda = _num(r.precoVenda);
      if (r.dataCompra instanceof Date) r.dataCompra = Utilities.formatDate(r.dataCompra, "GMT", "yyyy-MM-dd");
      return r;
    });
    var compras = _lerAba(ABA_COMPRAS, COL_COMPRAS).map(function (r) {
      r.qtd = _num(r.qtd); r.precoUnit = _num(r.precoUnit);
      if (r.data instanceof Date) r.data = Utilities.formatDate(r.data, "GMT", "yyyy-MM-dd");
      return r;
    }).reverse(); // mais recentes primeiro
    var fornecedores = _lerAba(ABA_FORNECEDORES, COL_FORNECEDORES);
    var precos = _lerAba(ABA_PRECOS, COL_PRECOS).map(function (r) {
      r.preco = _num(r.preco);
      if (r.data instanceof Date) r.data = Utilities.formatDate(r.data, "GMT", "yyyy-MM-dd");
      return r;
    });
    var lojas = _lerAba(ABA_LOJAS, COL_LOJAS);
    var pdvs = _lerAba(ABA_PDVS, COL_PDVS);
    var pdvEstoque = _lerAba(ABA_PDV_ESTOQUE, COL_PDV_ESTOQUE).map(function (r) {
      r.qtd = _num(r.qtd); r.minimo = _num(r.minimo); r.nivelPar = _num(r.nivelPar); r.precoVenda = _num(r.precoVenda); return r;
    });
    var vendas = _lerAba(ABA_VENDAS, COL_VENDAS).map(function (r) {
      r.qtd = _num(r.qtd); r.precoMedio = _num(r.precoMedio); r.valorVendido = _num(r.valorVendido);
      ["periodoInicio", "periodoFim", "importadoEm"].forEach(function (k) {
        if (r[k] instanceof Date) r[k] = Utilities.formatDate(r[k], "GMT", "yyyy-MM-dd");
      });
      return r;
    });
    var guia = [];
    var pg = (e && e.parameter) ? e.parameter : {};
    try { guia = lerGuia(pg.guiaId, pg.guiaGid).guia; } catch (eg) { guia = []; } // nunca deixa o guia quebrar a carga
    return _json({ estoque: estoque, compras: compras, fornecedores: fornecedores, precos: precos, lojas: lojas,
      pdvs: pdvs, pdvEstoque: pdvEstoque, vendas: vendas, guia: guia });
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
      case "excluirCompra":    r = excluirCompra(body.linha); break;
      case "varrerAgora":      r = varrerPrecosPublicos(false); break;
      case "salvarLoja":       r = salvarLoja(body.loja, body.urlOriginal); break;
      case "excluirLoja":      r = excluirLoja(body.url); break;
      case "salvarPdv":        r = salvarPdv(body.pdv, body.nomeOriginal); break;
      case "abastecerPdv":     r = abastecerPdv(body.sku, body.pdv, body.qtd); break;
      case "ajustarPdv":       r = ajustarPdv(body.sku, body.pdv, body.qtd); break;
      case "ajustarPrecoPdv":  r = ajustarPrecoPdv(body.sku, body.pdv, body.preco); break;
      case "importarPlanograma": r = importarPlanograma(body.pdv, body.itens); break;
      case "importarVendas":   r = importarVendas(body.periodoInicio, body.periodoFim, body.pdv, body.itens); break;
      case "excluirVenda":     r = excluirVenda(body.venda); break;
      case "excluirVendasPeriodo": r = excluirVendasPeriodo(body.pdv, body.periodoInicio, body.periodoFim); break;
      case "salvarVinhoGuia":  r = salvarVinhoGuia(body.vinho, body.idOriginal, body.guiaId, body.guiaGid); break;
      case "excluirVinhoGuia": r = excluirVinhoGuia(body.id, body.guiaId, body.guiaGid); break;
      case "salvarFotoGuia":   r = salvarFotoGuia(body.id, body.base64); break;
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
  // A compra entra na RETAGUARDA. Casa pelo sku (vindo da conferência da nota) e,
  // se não houver, pelo nome. Cria o rótulo se não existir.
  var est = _aba(ABA_ESTOQUE, COL_ESTOQUE);
  var linha = compra.sku ? _acharLinha(est, compra.sku) : -1;
  if (linha < 0) linha = _acharLinhaPorNome(est, compra.nome);
  if (linha > 0) {
    var qCol = COL_ESTOQUE.indexOf("qtd") + 1;
    var atual = _num(est.getRange(linha, qCol).getValue());
    est.getRange(linha, qCol).setValue(atual + _num(compra.qtd));
    if (compra.precoUnit) est.getRange(linha, COL_ESTOQUE.indexOf("precoAquisicao") + 1).setValue(_num(compra.precoUnit));
    if (compra.fornecedor) est.getRange(linha, COL_ESTOQUE.indexOf("fornecedor") + 1).setValue(compra.fornecedor);
    if (compra.data) est.getRange(linha, COL_ESTOQUE.indexOf("dataCompra") + 1).setValue(compra.data);
    if (compra.codigoBarras) {
      var cbCol = COL_ESTOQUE.indexOf("codigoBarras") + 1;
      if (!String(est.getRange(linha, cbCol).getValue()).trim()) est.getRange(linha, cbCol).setValue(compra.codigoBarras);
    }
  } else {
    est.appendRow(_objParaLinha({
      sku: compra.sku || _slug(compra.nome), nome: compra.nome, tipo: "Tinto", uva: "", produtor: "",
      qtd: _num(compra.qtd), minimo: 3, precoAquisicao: _num(compra.precoUnit),
      fornecedor: compra.fornecedor || "", dataCompra: compra.data || "", obs: "",
      codigo: "", codigoBarras: compra.codigoBarras || "", categoria: "", precoVenda: 0
    }, COL_ESTOQUE));
  }
  _garanteFornecedor(compra.fornecedor);
  return { ok: true };
}

// Exclui uma compra do histórico pelo nº da linha (não altera o estoque).
function excluirCompra(linha) {
  linha = parseInt(linha, 10);
  if (!linha || linha < 2) throw new Error("Compra inválida.");
  var sh = _aba(ABA_COMPRAS, COL_COMPRAS);
  if (linha <= sh.getLastRow()) sh.deleteRow(linha);
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
 *  FASE 4 — Estoque (retaguarda) ↔ PDV (adega) + importação de planilhas
 * ==========================================================================
 *  Cada RÓTULO tem uma quantidade de RETAGUARDA (coluna `qtd` da aba Estoque) e
 *  uma quantidade EM CADA ADEGA (aba PdvEstoque, uma linha por pdv+sku). Os
 *  movimentos: comprar soma na retaguarda; abastecer tira da retaguarda e põe na
 *  adega; vender (importar) desconta da adega; importar planograma acerta a adega
 *  com a posição real do sistema.
 */

// Cria uma adega (PDV) ou atualiza o status ativo/obs de uma existente.
// (Não renomeia em cascata — fora do escopo atual.)
function salvarPdv(pdv, nomeOriginal) {
  pdv = pdv || {};
  var nome = String(pdv.nome || "").trim();
  if (!nome) throw new Error("Informe o nome da adega.");
  var sh = _aba(ABA_PDVS, COL_PDVS);
  var alvo = String(nomeOriginal || nome).trim();
  var linha = _acharLinhaCol(sh, 1, alvo); // coluna 1 = nome
  var ativo = (pdv.ativo == null || pdv.ativo === "") ? "sim" : String(pdv.ativo);
  var obj = { nome: (linha > 0 ? alvo : nome), ativo: ativo, obs: pdv.obs || "" };
  var arr = _objParaLinha(obj, COL_PDVS);
  if (linha > 0) sh.getRange(linha, 1, 1, COL_PDVS.length).setValues([arr]);
  else sh.appendRow(arr);
  return { ok: true };
}

// Garante que uma adega (PDV) exista na aba Pdvs.
function _garantePdv(nome) {
  nome = (nome || "").toString().trim(); if (!nome) return;
  var sh = _aba(ABA_PDVS, COL_PDVS);
  var lista = _lerAba(ABA_PDVS, COL_PDVS);
  if (!lista.some(function (p) { return String(p.nome).trim() === nome; })) sh.appendRow([nome, "sim", ""]);
}

// Acha a linha (na planilha) de um rótulo numa adega, por pdv+sku.
function _acharLinhaPdv(sh, pdv, sku) {
  var cP = COL_PDV_ESTOQUE.indexOf("pdv"), cS = COL_PDV_ESTOQUE.indexOf("sku");
  var n = sh.getLastRow() - 1; if (n < 1) return -1;
  var vals = sh.getRange(2, 1, n, COL_PDV_ESTOQUE.length).getValues();
  for (var i = 0; i < vals.length; i++)
    if (String(vals[i][cP]) === String(pdv) && String(vals[i][cS]) === String(sku)) return i + 2;
  return -1;
}
function _qtdPdv(pdv, sku) {
  var sh = _aba(ABA_PDV_ESTOQUE, COL_PDV_ESTOQUE);
  var linha = _acharLinhaPdv(sh, pdv, sku);
  if (linha < 0) return 0;
  return _num(sh.getRange(linha, COL_PDV_ESTOQUE.indexOf("qtd") + 1).getValue());
}
// Cria/atualiza a linha de PDV de um rótulo (campos = objeto com o que mudar).
function _setPdvEstoque(pdv, sku, campos) {
  var sh = _aba(ABA_PDV_ESTOQUE, COL_PDV_ESTOQUE);
  var linha = _acharLinhaPdv(sh, pdv, sku);
  var obj;
  if (linha > 0) {
    var atual = sh.getRange(linha, 1, 1, COL_PDV_ESTOQUE.length).getValues()[0];
    obj = {}; for (var i = 0; i < COL_PDV_ESTOQUE.length; i++) obj[COL_PDV_ESTOQUE[i]] = atual[i];
  } else { obj = { pdv: pdv, sku: sku, qtd: 0, minimo: 0, nivelPar: 0 }; }
  for (var k in campos) obj[k] = campos[k];
  if (linha > 0) sh.getRange(linha, 1, 1, COL_PDV_ESTOQUE.length).setValues([_objParaLinha(obj, COL_PDV_ESTOQUE)]);
  else sh.appendRow(_objParaLinha(obj, COL_PDV_ESTOQUE));
  return obj;
}
// Reescreve as linhas de dados de uma aba a partir de uma lista de objetos.
function _regravaAba(sh, colunas, objs) {
  var linhas = objs.map(function (o) { return _objParaLinha(o, colunas); });
  var lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, colunas.length).clearContent();
  if (linhas.length) sh.getRange(2, 1, linhas.length, colunas.length).setValues(linhas);
}

// Abastecer: tira `qtd` da retaguarda do rótulo e soma na adega.
function abastecerPdv(sku, pdv, qtd) {
  qtd = _num(qtd); if (qtd <= 0) return { ok: true };
  _garantePdv(pdv);
  var shE = _aba(ABA_ESTOQUE, COL_ESTOQUE);
  var linhaE = _acharLinha(shE, sku);
  if (linhaE > 0) {
    var qCol = COL_ESTOQUE.indexOf("qtd") + 1;
    var atual = _num(shE.getRange(linhaE, qCol).getValue());
    shE.getRange(linhaE, qCol).setValue(Math.max(0, atual - qtd));
  }
  _setPdvEstoque(pdv, sku, { qtd: _qtdPdv(pdv, sku) + qtd });
  return { ok: true };
}

// Ajuste direto da quantidade na adega (valor absoluto).
function ajustarPdv(sku, pdv, qtd) {
  _garantePdv(pdv);
  _setPdvEstoque(pdv, sku, { qtd: Math.max(0, _num(qtd)) });
  return { ok: true };
}

// Preço de venda de um rótulo NESTA adega (por PDV).
function ajustarPrecoPdv(sku, pdv, preco) {
  _garantePdv(pdv);
  _setPdvEstoque(pdv, sku, { precoVenda: Math.max(0, _num(preco)) });
  return { ok: true };
}

// Importar planograma: acerta a adega com a posição do sistema + cadastra rótulos
// novos. itens = [{ sku, novo, rotulo:{...}, quantAtual, minimo, nivelPar }].
function importarPlanograma(pdv, itens) {
  itens = itens || []; _garantePdv(pdv);
  var shE = _aba(ABA_ESTOQUE, COL_ESTOQUE);
  var shP = _aba(ABA_PDV_ESTOQUE, COL_PDV_ESTOQUE);
  var est = _lerAba(ABA_ESTOQUE, COL_ESTOQUE);
  var pdvRows = _lerAba(ABA_PDV_ESTOQUE, COL_PDV_ESTOQUE);
  var mapE = {}; est.forEach(function (r) { mapE[r.sku] = r; });
  var mapP = {}; pdvRows.forEach(function (r) { mapP[r.pdv + "||" + r.sku] = r; });
  itens.forEach(function (it) {
    var sku = it.sku, d = it.rotulo || {};
    var e = mapE[sku];
    if (!e) {
      e = { sku: sku, nome: d.nome || "", tipo: d.tipo || "Tinto", uva: "", produtor: "", qtd: 0, minimo: 0,
        precoAquisicao: 0, fornecedor: "", dataCompra: "", obs: "", codigo: d.codigo || "", codigoBarras: d.codigoBarras || "",
        categoria: d.categoria || "", precoVenda: _num(d.precoVenda) };
      mapE[sku] = e; est.push(e);
    } else {
      if (d.nome) e.nome = d.nome; if (d.codigo) e.codigo = d.codigo; if (d.codigoBarras) e.codigoBarras = d.codigoBarras;
      if (d.categoria) e.categoria = d.categoria; if (d.tipo) e.tipo = d.tipo;
      // NÃO sobrescreve o precoVenda do rótulo (é só o "padrão"); o preço do
      // planograma vai para a ADEGA (pdvEstoque), pois é por máquina.
    }
    var key = pdv + "||" + sku, p = mapP[key];
    if (!p) { p = { pdv: pdv, sku: sku, qtd: 0, minimo: 0, nivelPar: 0, precoVenda: 0 }; mapP[key] = p; pdvRows.push(p); }
    p.qtd = _num(it.quantAtual);
    if (it.minimo != null) p.minimo = _num(it.minimo);
    if (it.nivelPar != null) p.nivelPar = _num(it.nivelPar);
    if (d.precoVenda != null && d.precoVenda !== "") p.precoVenda = _num(d.precoVenda); // preço DESTA adega
  });
  _regravaAba(shE, COL_ESTOQUE, est);
  _regravaAba(shP, COL_PDV_ESTOQUE, pdvRows);
  return { ok: true, rotulos: itens.length };
}

// Importar vendas: grava o histórico do período e desconta da adega. itens =
// [{ sku, novo, rotulo:{...}, codigo, categoria, qtd, precoMedio, valorVendido }].
function importarVendas(periodoInicio, periodoFim, pdv, itens) {
  itens = itens || []; _garantePdv(pdv);
  var shE = _aba(ABA_ESTOQUE, COL_ESTOQUE);
  var shP = _aba(ABA_PDV_ESTOQUE, COL_PDV_ESTOQUE);
  var shV = _aba(ABA_VENDAS, COL_VENDAS);
  var hoje = Utilities.formatDate(new Date(), "GMT-3", "yyyy-MM-dd");
  var est = _lerAba(ABA_ESTOQUE, COL_ESTOQUE);
  var pdvRows = _lerAba(ABA_PDV_ESTOQUE, COL_PDV_ESTOQUE);
  var mapE = {}; est.forEach(function (r) { mapE[r.sku] = r; });
  var mapP = {}; pdvRows.forEach(function (r) { mapP[r.pdv + "||" + r.sku] = r; });
  var vendasRows = [];
  itens.forEach(function (it) {
    var sku = it.sku, d = it.rotulo || {};
    if (!mapE[sku] && it.novo) {
      var e = { sku: sku, nome: d.nome || "", tipo: d.tipo || "Tinto", uva: "", produtor: "", qtd: 0, minimo: 0,
        precoAquisicao: 0, fornecedor: "", dataCompra: "", obs: "", codigo: d.codigo || it.codigo || "", codigoBarras: "",
        categoria: d.categoria || it.categoria || "", precoVenda: _num(d.precoVenda) };
      mapE[sku] = e; est.push(e);
    }
    vendasRows.push({ periodoInicio: periodoInicio, periodoFim: periodoFim, importadoEm: hoje, pdv: pdv, sku: sku,
      codigo: it.codigo || "", descricao: d.nome || "", categoria: it.categoria || "",
      qtd: _num(it.qtd), precoMedio: _num(it.precoMedio), valorVendido: _num(it.valorVendido) });
    if (mapE[sku]) {
      var key = pdv + "||" + sku, p = mapP[key];
      if (!p) { p = { pdv: pdv, sku: sku, qtd: 0, minimo: 0, nivelPar: 0 }; mapP[key] = p; pdvRows.push(p); }
      p.qtd = Math.max(0, _num(p.qtd) - _num(it.qtd));
    }
  });
  _regravaAba(shE, COL_ESTOQUE, est);
  _regravaAba(shP, COL_PDV_ESTOQUE, pdvRows);
  if (vendasRows.length) {
    var start = shV.getLastRow() + 1;
    sh_setBloco(shV, start, vendasRows, COL_VENDAS);
  }
  return { ok: true, rotulos: itens.length };
}
function sh_setBloco(sh, start, objs, colunas) {
  sh.getRange(start, 1, objs.length, colunas.length).setValues(objs.map(function (o) { return _objParaLinha(o, colunas); }));
}

// Data como texto yyyy-MM-dd (a planilha às vezes guarda datas como objeto Date).
function _fmtData(x) { return (x instanceof Date) ? Utilities.formatDate(x, "GMT", "yyyy-MM-dd") : String(x || ""); }

// Exclui todas as vendas de um período e DEVOLVE as garrafas à adega.
function excluirVendasPeriodo(pdv, inicio, fim) {
  var sh = _aba(ABA_VENDAS, COL_VENDAS);
  var vendas = _lerAba(ABA_VENDAS, COL_VENDAS);
  var manter = [], remover = [];
  vendas.forEach(function (v) {
    if (String(v.pdv) === String(pdv) && _fmtData(v.periodoInicio) === String(inicio) && _fmtData(v.periodoFim) === String(fim)) remover.push(v);
    else manter.push(v);
  });
  remover.forEach(function (v) { if (v.sku) _setPdvEstoque(v.pdv, v.sku, { qtd: _qtdPdv(v.pdv, v.sku) + _num(v.qtd) }); });
  _regravaAba(sh, COL_VENDAS, manter);
  return { ok: true, removidas: remover.length };
}

// Exclui UMA venda (a 1ª que casar) e devolve a garrafa à adega.
function excluirVenda(venda) {
  if (!venda) return { ok: true };
  var sh = _aba(ABA_VENDAS, COL_VENDAS);
  var vendas = _lerAba(ABA_VENDAS, COL_VENDAS);
  var removida = null, manter = [];
  for (var i = 0; i < vendas.length; i++) {
    if (!removida && _mesmaVenda(vendas[i], venda)) { removida = vendas[i]; continue; }
    manter.push(vendas[i]);
  }
  if (removida) {
    if (removida.sku) _setPdvEstoque(removida.pdv, removida.sku, { qtd: _qtdPdv(removida.pdv, removida.sku) + _num(removida.qtd) });
    _regravaAba(sh, COL_VENDAS, manter);
  }
  return { ok: true, removidas: removida ? 1 : 0 };
}
function _mesmaVenda(a, b) {
  return String(a.pdv) === String(b.pdv) && String(a.sku) === String(b.sku) &&
    _fmtData(a.periodoInicio) === _fmtData(b.periodoInicio) && _fmtData(a.periodoFim) === _fmtData(b.periodoFim) &&
    _fmtData(a.importadoEm) === _fmtData(b.importadoEm) &&
    _num(a.qtd) === _num(b.qtd) && _num(a.valorVendido) === _num(b.valorVendido);
}

/**
 * ==========================================================================
 *  GUIA DO QR — editar (por aqui) a planilha que o guia do cliente lê
 * ==========================================================================
 *  O guia (o app que o cliente abre no QR da porta) lê os vinhos de OUTRA
 *  planilha, publicada em CSV. Este backend abre essa planilha pelo ID e
 *  lê/escreve nela — assim o dono edita o guia de dentro do app de gestão, e o
 *  guia do cliente atualiza sozinho (o CSV publicado se atualiza em minutos).
 *
 *  ONDE FICA O ID DA PLANILHA DO GUIA: o app manda o ID+gid no próprio pedido
 *  (o usuário cola o link do guia na engrenagem ⚙ — mesmo lugar da conexão do
 *  estoque). Como plano B, também aceita as Propriedades do script
 *  GUIA_SHEET_ID / GUIA_ABA (nome ou gid).
 * -------------------------------------------------------------------------- */
function _guiaAba(id, gidOrName) {
  id = id || _prop("GUIA_SHEET_ID");
  if (!id) return null;
  var ss = SpreadsheetApp.openById(id);
  var aba = gidOrName || _prop("GUIA_ABA");
  if (aba) {
    var porNome = ss.getSheetByName(String(aba));
    if (porNome) return porNome;
    var gid = parseInt(aba, 10); // permite informar o gid (número) em vez do nome
    if (!isNaN(gid)) {
      var sheets = ss.getSheets();
      for (var i = 0; i < sheets.length; i++) if (sheets[i].getSheetId() === gid) return sheets[i];
    }
  }
  return ss.getSheets()[0] || null;
}
// Lê uma aba (objeto sheet) usando a própria 1ª linha como cabeçalho.
function _lerSheetObj(sh) {
  if (!sh) return [];
  var valores = sh.getDataRange().getValues();
  if (valores.length < 2) return [];
  var cab = valores[0].map(function (c) { return String(c).trim(); });
  var out = [];
  for (var i = 1; i < valores.length; i++) {
    var linha = valores[i];
    if (linha.every(function (c) { return c === "" || c === null; })) continue;
    var obj = {};
    for (var j = 0; j < cab.length; j++) obj[cab[j]] = linha[j];
    obj.__row = i + 1;
    out.push(obj);
  }
  return out;
}
function _acharLinhaCol(sh, col, valor) {
  var n = sh.getLastRow() - 1; if (n < 1 || col < 1) return -1;
  var vals = sh.getRange(2, col, n, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(valor)) return i + 2;
  return -1;
}

function lerGuia(id, gid) {
  var sh = _guiaAba(id, gid);
  if (!sh) return { guia: [] };
  var linhas = _lerSheetObj(sh).map(function (r) {
    ["docura", "corpo", "taninos", "acidez"].forEach(function (k) { if (r[k] !== undefined) r[k] = _num(r[k]); });
    return r;
  });
  return { guia: linhas };
}

function salvarVinhoGuia(vinho, idOriginal, id, gid) {
  var sh = _guiaAba(id, gid);
  if (!sh) throw new Error("Planilha do guia não configurada (cole o link do guia na engrenagem ⚙).");
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (c) { return String(c).trim(); });
  var idCol = header.indexOf("id");
  if (idCol < 0) throw new Error("A planilha do guia precisa de uma coluna 'id'.");
  var alvo = idOriginal || vinho.id;
  var linha = _acharLinhaCol(sh, idCol + 1, alvo);
  var arr = header.map(function (col) { return vinho[col] != null ? vinho[col] : ""; });
  if (linha > 0) sh.getRange(linha, 1, 1, header.length).setValues([arr]);
  else sh.appendRow(arr);
  return { ok: true };
}

function excluirVinhoGuia(vinhoId, id, gid) {
  var sh = _guiaAba(id, gid);
  if (!sh) return { ok: true };
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (c) { return String(c).trim(); });
  var idCol = header.indexOf("id");
  if (idCol < 0) return { ok: true };
  var linha = _acharLinhaCol(sh, idCol + 1, vinhoId);
  if (linha > 0) sh.deleteRow(linha);
  return { ok: true };
}

/**
 * Sobe a foto (PNG em base64) para o repositório do guia via API do GitHub.
 * O guia (GitHub Pages) passa a servir o arquivo em fotos/<id>.png.
 * Propriedades do script necessárias:
 *   GITHUB_TOKEN = token do GitHub com permissão de escrever no repo do guia
 *   GUIA_REPO    = "usuario/repo" do guia (ex.: thiagosampaio112/vinho24h)
 *   GUIA_BRANCH  = (opcional) branch; vazio = "main"
 */
function salvarFotoGuia(id, base64) {
  var token = _prop("GITHUB_TOKEN");
  var repo = _prop("GUIA_REPO");
  if (!token || !repo) throw new Error("Faltam GITHUB_TOKEN / GUIA_REPO nas propriedades do script.");
  if (!id || !base64) throw new Error("Foto inválida.");
  var branch = _prop("GUIA_BRANCH") || "main";
  var caminho = "fotos/" + _slug(id) + ".png";
  var base = "https://api.github.com/repos/" + repo + "/contents/" + caminho;
  var headers = { "Authorization": "token " + token, "Accept": "application/vnd.github+json", "User-Agent": "vinho24h-gestao" };
  // Se o arquivo já existe, precisa do SHA atual para sobrescrever.
  var sha = null;
  var g = UrlFetchApp.fetch(base + "?ref=" + encodeURIComponent(branch), { method: "get", headers: headers, muteHttpExceptions: true });
  if (g.getResponseCode() === 200) { try { sha = JSON.parse(g.getContentText()).sha; } catch (e) {} }
  var payload = { message: "guia: foto " + caminho, content: base64, branch: branch };
  if (sha) payload.sha = sha;
  var r = UrlFetchApp.fetch(base, { method: "put", headers: headers, contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true });
  var code = r.getResponseCode();
  if (code >= 300) throw new Error("GitHub " + code + ": " + r.getContentText().slice(0, 180));
  return { ok: true, path: caminho };
}

/**
 * ==========================================================================
 *  FASE 2 — Leitura de nota fiscal por IA
 * ==========================================================================
 *  A leitura da nota (foto/PDF) é feita DIRETO NO CELULAR, chamando a API do
 *  Gemini a partir do próprio app (a chave da IA fica guardada só no aparelho,
 *  colada na tela de engrenagem ⚙). Por isso NÃO há código de IA aqui no
 *  servidor — este Apps Script cuida apenas de ler/escrever na planilha.
 *  Os itens conferidos pelo usuário chegam aqui como "registrarCompra".
 */

/**
 * ==========================================================================
 *  FASE 3B — Radar de preço público (via Buscapé)
 * ==========================================================================
 *  Para cada vinho do ESTOQUE, este script busca o rótulo no Buscapé (que já
 *  agrega várias lojas), escolhe o resultado que melhor casa com o nome, e
 *  guarda o menor preço público achado (aba Precos). Quando esse preço fica
 *  ABAIXO do que você paga (precoAquisicao) ou cai vs. a última busca, manda um
 *  e-mail. É PREÇO PÚBLICO (não o de sócio logado) — serve de NORTE para a
 *  conferência humana. O app sempre mostra o produto encontrado + link, para
 *  você checar se casou certo.
 *
 *  COMO LIGAR (uma vez):
 *    1) Rode a função `instalarGatilhoDiario` (▶ Executar) e autorize.
 *    2) (Opcional) Propriedade `EMAIL_ALERTA` = e-mail que recebe os avisos.
 *  Testar na hora: rode `varrerAgora` (ou o botão "Buscar preços públicos").
 * -------------------------------------------------------------------------- */

var _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function varrerPrecosPublicos(enviarEmail) {
  var estoque = _lerAba(ABA_ESTOQUE, COL_ESTOQUE).filter(function (x) { return String(x.nome || "").trim(); });
  var lojas = _lerAba(ABA_LOJAS, COL_LOJAS).filter(function (l) {
    var a = String(l.ativo || "sim").toLowerCase();
    return l.url && a !== "nao" && a !== "não" && a !== "false" && a !== "0";
  });
  var historico = _lerAba(ABA_PRECOS, COL_PRECOS);
  var shP = _aba(ABA_PRECOS, COL_PRECOS);
  var hoje = Utilities.formatDate(new Date(), "GMT-3", "yyyy-MM-dd");
  var achados = 0, oportunidades = [];

  for (var i = 0; i < estoque.length; i++) {
    var item = estoque[i];
    var termo = _termoBusca(item.nome);
    // Junta candidatos do Buscapé + de cada loja de confiança (VTEX ou Nuvemshop).
    var candidatos = buscarBuscape(termo);
    for (var l = 0; l < lojas.length; l++) {
      candidatos = candidatos.concat(buscarLoja(lojas[l].url, termo));
      Utilities.sleep(300);
    }
    var melhores = escolherMelhores(item.nome, candidatos, 5); // até 5 lojas, ranqueadas
    if (!melhores.length) continue;
    achados++;
    var anterior = _ultimoPrecoPublico(historico, item.nome); // menor já visto antes de hoje
    // Grava TODAS as ofertas do dia (uma linha por loja) para o app montar a lista.
    for (var mi = 0; mi < melhores.length; mi++) {
      var of = melhores[mi];
      var linha = { data: hoje, consulta: item.nome, achado: of.nome, preco: of.preco, url: of.url, site: of.site || "" };
      shP.appendRow(_objParaLinha(linha, COL_PRECOS));
      historico.push(linha);
    }
    var melhor = melhores[0]; // o mais barato dispara o alerta
    var custo = _num(item.precoAquisicao);
    var maisBarato = custo > 0 && melhor.preco < custo;
    var caiu = anterior > 0 && melhor.preco < anterior;
    if (maisBarato || caiu) {
      oportunidades.push({ nome: item.nome, achado: melhor.nome, preco: melhor.preco, custo: custo, anterior: anterior, url: melhor.url, site: melhor.site || "", maisBarato: maisBarato });
    }
    Utilities.sleep(400); // gentileza com os sites
  }

  if (enviarEmail && oportunidades.length) _emailOportunidades(oportunidades);
  return { vinhos: estoque.length, achados: achados, oportunidades: oportunidades };
}

function varrerDiaria() { varrerPrecosPublicos(true); }   // usado pelo gatilho (manda e-mail)
function varrerAgora() { return varrerPrecosPublicos(false); } // atalho manual no editor

// Busca no Buscapé e devolve candidatos {nome, preco, url} (preço por garrafa).
function buscarBuscape(termo) {
  try {
    var url = "https://www.buscape.com.br/search?q=" + encodeURIComponent(termo);
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { "User-Agent": _UA } });
    if (resp.getResponseCode() !== 200) return [];
    var html = resp.getContentText();
    var out = [];
    // Cada card começa em href="/..." data-testid="product-card::card".
    var re = /href="(\/[^"]+)"\s+data-testid="product-card::card"([\s\S]*?)(?=href="\/[^"]+"\s+data-testid="product-card::card"|<\/main>|$)/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var link = m[1].replace(/&amp;/g, "&");
      var bloco = m[2];
      var nm = bloco.match(/data-testid="product-card::name"[^>]*>([^<]+)</i);
      var pm = bloco.match(/data-testid="product-card::price"[\s\S]*?R\$\s*([\d.]*\d,\d{2})/i);
      if (!nm || !pm) continue;
      var nome = _htmlDecode(nm[1]).trim();
      var preco = _numBR(pm[1]);
      if (nome && preco > 0) out.push({ nome: nome, preco: preco, url: "https://www.buscape.com.br" + link, site: "buscape.com.br" });
      if (out.length >= 25) break;
    }
    return out;
  } catch (e) { return []; }
}

// Despachante: tenta a loja como VTEX (API JSON) e, se não vier nada, como
// Nuvemshop (JSON-LD). Assim o usuário cadastra qualquer loja sem saber a plataforma.
function buscarLoja(base, termo) {
  var r = buscarVtex(base, termo);
  if (r && r.length) return r;
  return buscarNuvemshop(base, termo);
}

// Busca numa loja VTEX pela API pública de catálogo (JSON limpo). Cobre muitas
// lojas grandes (ex.: Divvino, World Wine). Serve para qualquer loja VTEX.
function buscarVtex(base, termo) {
  try {
    var raiz = String(base || "").replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(raiz)) raiz = "https://" + raiz;
    var url = raiz + "/api/catalog_system/pub/products/search?ft=" + encodeURIComponent(termo) + "&_from=0&_to=9";
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { "User-Agent": _UA } });
    var code = resp.getResponseCode();
    if (code !== 200 && code !== 206) return []; // VTEX responde 206 na busca paginada
    var arr; try { arr = JSON.parse(resp.getContentText()); } catch (e) { return []; }
    if (!Array.isArray(arr) || !arr.length) return [];
    var site = _site(raiz), out = [];
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      var preco = _precoVtex(p);
      if (!preco) continue; // sem oferta disponível
      out.push({ nome: _htmlDecode(String(p.productName || "")).trim(), preco: preco, url: p.link || raiz, site: site });
      if (out.length >= 25) break;
    }
    return out;
  } catch (e) { return []; }
}

// Menor preço disponível entre os itens/sellers de um produto VTEX.
function _precoVtex(p) {
  var items = p.items || [];
  var min = 0;
  for (var i = 0; i < items.length; i++) {
    var sellers = items[i].sellers || [];
    for (var j = 0; j < sellers.length; j++) {
      var co = sellers[j].commertialOffer; // (o VTEX escreve "commertial" mesmo)
      if (!co) continue;
      if (co.IsAvailable === false || co.AvailableQuantity === 0) continue;
      var v = parseFloat(co.Price || 0);
      if (v > 0 && (!min || v < min)) min = v;
    }
  }
  return min;
}

// Busca numa loja Nuvemshop (plataforma padrão). Lê os produtos do JSON-LD.
// Serve para qualquer loja Nuvemshop — basta cadastrar o endereço.
function buscarNuvemshop(base, termo) {
  try {
    var raiz = String(base || "").replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(raiz)) raiz = "https://" + raiz;
    var url = raiz + "/search?q=" + encodeURIComponent(termo);
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { "User-Agent": _UA } });
    if (resp.getResponseCode() !== 200) return [];
    var html = resp.getContentText();
    var site = _site(raiz);
    var out = [];
    var blocos = html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
    for (var i = 0; i < blocos.length; i++) {
      var cru = blocos[i].replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim();
      var obj; try { obj = JSON.parse(cru); } catch (e) { continue; }
      var arr = Array.isArray(obj) ? obj : [obj];
      for (var k = 0; k < arr.length; k++) {
        var p = arr[k];
        if (!p || p["@type"] !== "Product" || !p.name) continue;
        var preco = _precoDeOffers(p.offers);
        if (!preco) continue;
        var link = (p.mainEntityOfPage && p.mainEntityOfPage["@id"]) || p.url || raiz;
        out.push({ nome: _htmlDecode(String(p.name)).trim(), preco: preco, url: link, site: site });
      }
      if (out.length >= 25) break;
    }
    return out;
  } catch (e) { return []; }
}

// Menor preço entre as ofertas do bloco JSON-LD (aceita objeto ou lista).
function _precoDeOffers(offers) {
  if (!offers) return 0;
  var arr = Array.isArray(offers) ? offers : [offers];
  var min = 0;
  for (var i = 0; i < arr.length; i++) {
    var o = arr[i]; if (!o) continue;
    var v = parseFloat(o.price != null ? o.price : (o.lowPrice != null ? o.lowPrice : 0));
    if (v > 0 && (!min || v < min)) min = v;
  }
  return min;
}

function _site(url) {
  var m = String(url).match(/^https?:\/\/([^\/]+)/i);
  return m ? m[1].replace(/^www\./i, "") : String(url);
}

// --- Lojas de confiança (CRUD na aba Lojas) ---
function salvarLoja(loja, urlOriginal) {
  if (!loja || !loja.url) throw new Error("Faltou o endereço da loja.");
  if (loja.ativo == null || loja.ativo === "") loja.ativo = "sim";
  if (!loja.nome) loja.nome = _site(loja.url);
  var sh = _aba(ABA_LOJAS, COL_LOJAS);
  var linha = _acharLinhaPorCampo(sh, COL_LOJAS, "url", urlOriginal || loja.url);
  if (linha > 0) sh.getRange(linha, 1, 1, COL_LOJAS.length).setValues([_objParaLinha(loja, COL_LOJAS)]);
  else sh.appendRow(_objParaLinha(loja, COL_LOJAS));
  return { ok: true };
}
function excluirLoja(url) {
  var sh = _aba(ABA_LOJAS, COL_LOJAS);
  var linha = _acharLinhaPorCampo(sh, COL_LOJAS, "url", url);
  if (linha > 0) sh.deleteRow(linha);
  return { ok: true };
}
function _acharLinhaPorCampo(sh, colunas, campo, valor) {
  var col = colunas.indexOf(campo) + 1;
  var n = sh.getLastRow() - 1; if (n < 1 || col < 1) return -1;
  var vals = sh.getRange(2, col, n, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(valor)) return i + 2;
  return -1;
}

// Casa os candidatos com o nome buscado e devolve as MELHORES ofertas — uma por
// loja (a mais barata de cada), ranqueadas por preço (menor primeiro).
// Regra ESTRITA (para nunca mostrar match errado, tipo "Baron Lacroix" = boneco):
//   - precisa casar >=60% dos termos E ao menos 1 termo DISTINTIVO (nome do
//     produtor/rótulo, não uva/país genérico).
function escolherMelhores(nomeBusca, candidatos, limite) {
  var q = _tokens(nomeBusca);
  if (!q.length || !candidatos.length) return [];
  var distintivos = [];
  for (var d = 0; d < q.length; d++) if (!_GENERICO[q[d]]) distintivos.push(q[d]);
  var porSite = {}; // mantém a oferta mais barata de cada loja
  for (var i = 0; i < candidatos.length; i++) {
    var c = candidatos[i];
    // Ignora kits/caixas (preço não é por garrafa).
    if (/\bkit\b|\bcaixa\b|\bcx\b|combo|leve\s*\d|compre\s*\d/i.test(c.nome)) continue;
    var t = _tokens(c.nome), tset = {};
    for (var k = 0; k < t.length; k++) tset[t[k]] = 1;
    var hits = 0;
    for (var j = 0; j < q.length; j++) if (tset[q[j]]) hits++;
    if (hits / q.length < 0.6) continue;
    var temDistintivo = false;
    for (var e = 0; e < distintivos.length; e++) if (tset[distintivos[e]]) { temDistintivo = true; break; }
    if (!temDistintivo) continue;
    var s = c.site || "";
    if (!porSite[s] || c.preco < porSite[s].preco) porSite[s] = c;
  }
  var lista = [];
  for (var s2 in porSite) lista.push(porSite[s2]);
  lista.sort(function (a, b) { return a.preco - b.preco; });
  return lista.slice(0, limite || 5);
}

// Compatível: só a melhor oferta única (a mais barata).
function escolherMelhor(nomeBusca, candidatos) {
  var l = escolherMelhores(nomeBusca, candidatos, 1);
  return l.length ? l[0] : null;
}

// Termo de busca: tokens úteis com 3+ letras (tokens de 2 letras tipo "dv"
// quebram a busca de alguns sites, ex.: "D.V." indexado com pontos no VTEX).
// Os tokens curtos continuam valendo no casamento (escolherMelhor).
function _termoBusca(nome) {
  var t = _tokens(nome).filter(function (w) { return w.length >= 3; });
  if (!t.length) t = _tokens(nome); // rótulo só com tokens curtos: usa o que tem
  return t.slice(0, 6).join(" ");
}

// Palavras genéricas ignoradas na tokenização (não ajudam a distinguir o rótulo).
var _STOP = { vinho:1, tinto:1, branco:1, rose:1, rosado:1, seco:1, suave:1, doce:1, fino:1, natural:1,
  de:1, do:1, da:1, com:1, con:1, e:1, o:1, a:1, ml:1, un:1, und:1, garrafa:1, reserva:1, especial:1 };
// Tokens que contam no score mas NÃO valem como "distintivo" (uva, país, tipo de espumante).
var _GENERICO = { malbec:1, cabernet:1, sauvignon:1, merlot:1, carmenere:1, chardonnay:1, pinot:1, noir:1,
  grigio:1, gris:1, syrah:1, shiraz:1, tannat:1, blanc:1, semillon:1, viognier:1, bonarda:1, tempranillo:1,
  garnacha:1, grenache:1, sangiovese:1, espumante:1, brut:1, demi:1, sec:1, argentino:1, argentina:1,
  chileno:1, chilena:1, chile:1, portugues:1, portuguesa:1, frances:1, francesa:1, italiano:1, italiana:1,
  nacional:1, brasileiro:1, brasileira:1 };
function _tokens(s) {
  var base = String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  var brutos = base.replace(/[^a-z0-9]+/g, " ").split(/\s+/);
  var out = [];
  for (var i = 0; i < brutos.length; i++) {
    var w = brutos[i];
    if (!w || w.length < 2 || _STOP[w] === 1) continue;
    if (/^\d+$/.test(w)) continue; // números soltos (volume, safra)
    out.push(w);
  }
  return out;
}

function _numBR(s) { return parseFloat(String(s).replace(/\./g, "").replace(",", ".")) || 0; }
function _htmlDecode(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}
// Menor preço já registrado para este vinho (antes de hoje, pois é chamado antes
// de gravar a busca atual). Serve para detectar "novo menor preço".
function _ultimoPrecoPublico(historico, consulta) {
  var min = 0;
  for (var i = 0; i < historico.length; i++) {
    if (String(historico[i].consulta) !== String(consulta)) continue;
    var v = _num(historico[i].preco);
    if (v > 0 && (!min || v < min)) min = v;
  }
  return min;
}
function _emailOportunidades(ops) {
  var para = _prop("EMAIL_ALERTA") || Session.getEffectiveUser().getEmail();
  if (!para) return;
  var linhas = ops.map(function (o) {
    var ctx = o.maisBarato && o.custo
      ? "R$ " + o.preco.toFixed(2) + " no varejo público (você paga R$ " + o.custo.toFixed(2) + ")"
      : "R$ " + o.preco.toFixed(2) + (o.anterior ? " (antes R$ " + o.anterior.toFixed(2) + ")" : "");
    return "• " + o.nome + "\n  " + ctx + "\n  achado: " + o.achado + "\n  " + o.url;
  }).join("\n\n");
  MailApp.sendEmail(para, "🍷 " + ops.length + " vinho(s) com preço público interessante",
    "Preço PÚBLICO (o de sócio logado costuma ser ainda menor — confira antes de decidir):\n\n" +
    linhas + "\n\n— Vinho 24H · Gestão");
}

// Agende a varredura para rodar 1x/dia (rode esta função uma vez, no editor).
function instalarGatilhoDiario() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "varrerDiaria") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("varrerDiaria").timeBased().everyDays(1).atHour(8).create();
  return "Gatilho diário instalado (roda todo dia por volta das 8h).";
}
