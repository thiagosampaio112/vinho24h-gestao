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

// Colunas de cada aba (a ORDEM tem que bater com a 1ª linha da planilha).
var COL_ESTOQUE = ["sku","nome","tipo","uva","produtor","qtd","minimo","precoAquisicao","fornecedor","dataCompra","obs"];
var COL_COMPRAS = ["data","nome","qtd","precoUnit","fornecedor","notaChave"];
var COL_FORNECEDORES = ["nome","contato","obs"];
var COL_PRECOS = ["data","consulta","achado","preco","url","site"];
var COL_LOJAS = ["nome","url","ativo"];

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
    var precos = _lerAba(ABA_PRECOS, COL_PRECOS).map(function (r) {
      r.preco = _num(r.preco);
      if (r.data instanceof Date) r.data = Utilities.formatDate(r.data, "GMT", "yyyy-MM-dd");
      return r;
    });
    var lojas = _lerAba(ABA_LOJAS, COL_LOJAS);
    return _json({ estoque: estoque, compras: compras, fornecedores: fornecedores, precos: precos, lojas: lojas });
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
