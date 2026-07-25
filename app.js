/* ==========================================================================
   VINHO 24 HORAS · GESTÃO — Lógica do app interno (estoque + compras)
   ==========================================================================

   COMO OS DADOS FUNCIONAM
   -----------------------
   • Enquanto API_URL estiver "" (vazio), o app roda em MODO DEMONSTRAÇÃO:
     tudo fica salvo só no próprio celular (localStorage). Serve para testar
     sem configurar nada. Cada aparelho tem seus próprios dados.

   • Quando você publicar o Google Apps Script (ver SETUP.md) e colar o link
     em API_URL, o app passa a LER e ESCREVER na SUA planilha nova — aí sim
     você, a esposa e a sócia veem o MESMO estoque, de qualquer celular.

   Esta planilha é NOVA e separada da planilha do guia de vinhos (a do QR).
   -------------------------------------------------------------------------- */

// A conexão com a planilha (link do Apps Script + senha) NÃO fica no código —
// por segurança, cada pessoa cola uma vez no próprio celular (ícone de
// engrenagem no topo → "Conectar à planilha"). Fica guardada só no aparelho.
const CFG_KEY = "vinho24h_gestao_cfg";
let API_URL = "";
let API_TOKEN = "";
let GEMINI_KEY = "";
let GUIA_URL = ""; // link da planilha do guia do QR (guardado no aparelho, como a conexão do estoque)
// Modelo da IA usada para ler as notas. Pode trocar se quiser outro.
const MODELO_IA = "gemini-2.5-flash";
function carregarConfig() {
  try { const c = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); API_URL = c.url || ""; API_TOKEN = c.token || ""; GEMINI_KEY = c.geminiKey || ""; GUIA_URL = c.guiaUrl || ""; } catch (_) {}
}
carregarConfig();

// Extrai o ID e o gid da aba a partir do link da planilha do guia colado na engrenagem.
function guiaRef() {
  const id = (String(GUIA_URL).match(/\/d\/([a-zA-Z0-9\-_]+)/) || [])[1] || "";
  const gid = (String(GUIA_URL).match(/[?#&]gid=(\d+)/) || [])[1] || "";
  return { id, gid };
}

// ---- Utilidades DOM -----------------------------------------------------
const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const online = () => !!API_URL;

// Formatação BRL e datas
const brl = (n) => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hojeISO = () => new Date().toISOString().slice(0, 10);
const dataBR = (iso) => { if (!iso) return "—"; const [a, m, d] = String(iso).slice(0, 10).split("-"); return d && m && a ? `${d}/${m}/${a}` : iso; };

// ---- Estado -------------------------------------------------------------
// Cada RÓTULO (em DADOS.estoque) tem um número de RETAGUARDA (campo `qtd` =
// garrafas guardadas para repor). As garrafas que estão NA ADEGA (à venda) ficam
// em DADOS.pdvEstoque, uma linha por (pdv, sku). Assim dá para ter várias adegas.
let DADOS = { estoque: [], compras: [], fornecedores: [], vigiados: [], precos: [], lojas: [], pdvs: [], pdvEstoque: [], vendas: [] };
const filtro = { busca: "", tipo: null, baixo: false };
let pdvAtual = ""; // nome da adega selecionada para visualizar/mexer
const LS_KEY = "vinho24h_gestao_dados_v2";

// ======================================================================
//  CAMADA DE DADOS  (Apps Script quando online; localStorage no demo)
// ======================================================================
async function apiGet() {
  const g = guiaRef();
  let url = `${API_URL}?token=${encodeURIComponent(API_TOKEN)}`;
  if (g.id) url += `&guiaId=${encodeURIComponent(g.id)}&guiaGid=${encodeURIComponent(g.gid)}`;
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return await resp.json();
}
async function apiPost(action, payload) {
  const g = guiaRef();
  // text/plain evita o "preflight" de CORS que o Apps Script não responde bem.
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, token: API_TOKEN, guiaId: g.id, guiaGid: g.gid, ...payload }),
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const json = await resp.json();
  if (json && json.erro) throw new Error(json.erro);
  return json;
}

// --- Fila de sincronização (UI otimista) ---------------------------------
// A tela é atualizada NA HORA (estado local) e a escrita vai pro backend em
// SEGUNDO PLANO. A fila é serial → preserva a ordem das ações (ex.: +/-/+
// numa quantidade chega ao servidor na sequência certa). Se uma escrita falha,
// a gente avisa e recarrega do servidor pra realinhar (auto-cura).
let _filaSync = Promise.resolve();
let _syncPendentes = 0;
function marcarSync() {
  const el = document.getElementById("sync-ind");
  if (el) el.classList.toggle("hidden", _syncPendentes === 0);
}
function enfileirar(action, payload) {
  _syncPendentes++; marcarSync();
  const run = _filaSync.then(() => apiPost(action, payload));
  _filaSync = run.catch(() => {}); // a fila não trava se um item falhar
  run.finally(() => { _syncPendentes--; marcarSync(); });
  return run;
}
// Escrita frequente: dispara em 2º plano; se falhar, recarrega do servidor.
function sincronizarFundo(action, payload) {
  enfileirar(action, payload).catch(async (err) => {
    console.error("sync falhou:", action, err);
    toast("⚠ Não consegui salvar na nuvem — recarregando os dados");
    try { await carregar(); renderAtual(); } catch (_) {}
  });
}

function lerLocal() {
  try { const s = localStorage.getItem(LS_KEY); if (s) return JSON.parse(s); } catch (_) {}
  return null;
}
function gravarLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(DADOS)); } catch (_) {} }

async function carregar() {
  if (online()) {
    DADOS = await apiGet();
    normalizarDados();
    gravarLocal(); // guarda uma cópia local p/ abrir instantâneo na próxima (cache-first)
    return;
  }
  DADOS = lerLocal() || SEED();
  normalizarDados();
}
// Garante que todos os campos-lista existem (evita erro ao ler cache antigo/parcial).
function normalizarDados() {
  DADOS.estoque = DADOS.estoque || []; DADOS.compras = DADOS.compras || []; DADOS.fornecedores = DADOS.fornecedores || [];
  DADOS.vigiados = DADOS.vigiados || []; DADOS.precos = DADOS.precos || []; DADOS.lojas = DADOS.lojas || [];
  DADOS.pdvs = DADOS.pdvs || []; DADOS.pdvEstoque = DADOS.pdvEstoque || []; DADOS.vendas = DADOS.vendas || [];
  DADOS.guia = DADOS.guia || []; // vinhos do guia do QR (editados por aqui, lidos pela planilha do guia)
  DADOS.despesas = DADOS.despesas || []; // despesas por adega (Fase 5)
  DADOS.despesas.forEach((d) => { d.valor = Number(d.valor) || 0; });
  // Sempre há ao menos uma adega. A 1ª ativa é a "adega atual" da tela.
  if (!DADOS.pdvs.length) DADOS.pdvs = [{ nome: "Ecopark", ativo: "sim" }];
  const ativas = pdvsAtivos();
  if (!pdvAtual || !ativas.some((p) => p.nome === pdvAtual)) pdvAtual = (ativas[0] || DADOS.pdvs[0]).nome;
  // Normaliza números das linhas de PDV.
  DADOS.pdvEstoque.forEach((r) => { r.qtd = Number(r.qtd) || 0; r.minimo = Number(r.minimo) || 0; r.nivelPar = Number(r.nivelPar) || 0; r.precoVenda = Number(r.precoVenda) || 0; });
  DADOS.pdvs.forEach((p) => { p.precoPadrao = Number(p.precoPadrao) || 0; });
}

// --- Ajudantes de PDV (ponto de venda / adega) ---
function pdvAtivoBool(p) {
  const a = String(p && p.ativo == null ? "sim" : p.ativo).toLowerCase();
  return !!(p && p.nome) && a !== "nao" && a !== "não" && a !== "false" && a !== "0";
}
function pdvsAtivos() { return (DADOS.pdvs || []).filter(pdvAtivoBool); }
function linhaPdv(sku, pdv) { return DADOS.pdvEstoque.find((r) => r.sku === sku && r.pdv === pdv); }
function qtdNoPdv(sku, pdv) { const r = linhaPdv(sku, pdv); return r ? (Number(r.qtd) || 0) : 0; }
function qtdPdvTotal(sku) { return DADOS.pdvEstoque.filter((r) => r.sku === sku).reduce((s, r) => s + (Number(r.qtd) || 0), 0); }
function minimoPdv(sku, pdv) { const r = linhaPdv(sku, pdv); return r ? (Number(r.minimo) || 0) : 0; }
// Garante (e devolve) a linha de PDV de um rótulo numa adega, no estado local.
function garantirLinhaPdv(sku, pdv) {
  let r = linhaPdv(sku, pdv);
  if (!r) { r = { pdv, sku, qtd: 0, minimo: 0, nivelPar: 0, precoVenda: 0 }; DADOS.pdvEstoque.push(r); }
  return r;
}
// Preço padrão de uma adega (vale para todos os vinhos dela, salvo exceções).
function precoPadraoAdega(pdv) {
  const p = (DADOS.pdvs || []).find((x) => x.nome === pdv);
  return p ? (Number(p.precoPadrao) || 0) : 0;
}
// Preço de venda efetivo de um rótulo NA adega: o preço específico do vinho
// (exceção) se houver; senão o PREÇO PADRÃO DA ADEGA.
function precoVendaNoPdv(sku, pdv) {
  const r = linhaPdv(sku, pdv);
  const pv = r ? (Number(r.precoVenda) || 0) : 0;
  if (pv > 0) return pv;
  return precoPadraoAdega(pdv);
}

// Gera um SKU simples quando o item não tem um.
function novoSku(nome) {
  const semAcento = (nome || "item").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const base = semAcento.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  let sku = base || "item", i = 2;
  while (DADOS.estoque.some((x) => x.sku === sku)) sku = `${base}-${i++}`;
  return sku;
}

// --- Operações (UI otimista: muta o estado local NA HORA + sincroniza em 2º
//     plano quando online; no demo o local já é a fonte da verdade) ---
async function salvarItem(item, skuOriginal) {
  if (!item.sku) item.sku = novoSku(item.nome);
  const lista = DADOS.estoque;
  const idx = lista.findIndex((x) => x.sku === (skuOriginal || item.sku));
  if (idx >= 0) lista[idx] = { ...lista[idx], ...item }; else lista.push(item);
  registrarFornecedor(item.fornecedor); gravarLocal();
  if (online()) sincronizarFundo("salvarItem", { item, skuOriginal });
}
async function excluirItem(sku) {
  DADOS.estoque = DADOS.estoque.filter((x) => x.sku !== sku); gravarLocal();
  if (online()) sincronizarFundo("excluirItem", { sku });
}
async function registrarCompra(compra) {
  DADOS.compras.unshift(compra);
  // A compra entra na RETAGUARDA do rótulo. Casa pelo sku (quando veio da
  // conferência da nota) e, se não, pelo nome. Cria o rótulo se não existir.
  let item = compra.sku ? DADOS.estoque.find((x) => x.sku === compra.sku) : null;
  if (!item) item = DADOS.estoque.find((x) => x.nome.toLowerCase() === compra.nome.toLowerCase());
  if (item) {
    item.qtd = (Number(item.qtd) || 0) + Number(compra.qtd);
    if (compra.precoUnit) item.precoAquisicao = compra.precoUnit;
    if (compra.fornecedor) item.fornecedor = compra.fornecedor;
    if (compra.data) item.dataCompra = compra.data;
    if (compra.codigoBarras && !item.codigoBarras) item.codigoBarras = compra.codigoBarras;
  } else {
    DADOS.estoque.push({ sku: compra.sku || novoSku(compra.nome), nome: compra.nome, tipo: "Tinto", uva: "", produtor: "",
      qtd: Number(compra.qtd), minimo: 3, precoAquisicao: compra.precoUnit || 0, precoVenda: 0,
      codigo: "", codigoBarras: compra.codigoBarras || "", categoria: "",
      fornecedor: compra.fornecedor || "", dataCompra: compra.data || "", obs: "" });
  }
  registrarFornecedor(compra.fornecedor); gravarLocal();
  if (online()) sincronizarFundo("registrarCompra", { compra });
}
function registrarFornecedor(nome) {
  nome = (nome || "").trim(); if (!nome) return;
  if (!DADOS.fornecedores.some((f) => (f.nome || f) === nome)) DADOS.fornecedores.push({ nome });
}

async function excluirCompra(compra) {
  const linha = compra.__row;
  const i = DADOS.compras.indexOf(compra); if (i >= 0) DADOS.compras.splice(i, 1); gravarLocal();
  if (online()) sincronizarFundo("excluirCompra", { linha });
}

// --- Despesas (Fase 5): por adega, para o cálculo do lucro líquido ---
async function registrarDespesa(despesa) {
  DADOS.despesas.unshift(despesa); gravarLocal();
  if (online()) sincronizarFundo("registrarDespesa", { despesa });
}
async function excluirDespesa(despesa) {
  const linha = despesa.__row;
  const i = DADOS.despesas.indexOf(despesa); if (i >= 0) DADOS.despesas.splice(i, 1);
  gravarLocal();
  if (online() && linha) sincronizarFundo("excluirDespesa", { linha });
}

// --- Lojas de confiança (radar de preço, Fase 3B) ---
function siteDe(url) { const m = String(url || "").match(/^https?:\/\/([^/]+)/i); return m ? m[1].replace(/^www\./i, "") : String(url || ""); }

async function salvarLoja(loja, urlOriginal) {
  if (!loja.nome) loja.nome = siteDe(loja.url);
  if (!loja.ativo) loja.ativo = "sim";
  const alvo = urlOriginal || loja.url;
  const idx = DADOS.lojas.findIndex((l) => l.url === alvo);
  if (idx >= 0) DADOS.lojas[idx] = { ...DADOS.lojas[idx], ...loja }; else DADOS.lojas.push(loja);
  gravarLocal();
  if (online()) sincronizarFundo("salvarLoja", { loja, urlOriginal });
}
async function excluirLoja(url) {
  DADOS.lojas = DADOS.lojas.filter((l) => l.url !== url); gravarLocal();
  if (online()) sincronizarFundo("excluirLoja", { url });
}

// --- Guia do QR (o app edita; a planilha do guia é escrita pelo backend) ---
function gerarIdGuia(nome) {
  const base = String(nome || "vinho").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "vinho";
  let id = base, i = 2;
  while (DADOS.guia.some((x) => x.id === id)) id = `${base}-${i++}`;
  return id;
}
async function salvarVinhoGuia(vinho, idOriginal) {
  if (!vinho.id) vinho.id = gerarIdGuia(vinho.nome);
  const alvo = idOriginal || vinho.id;
  const idx = DADOS.guia.findIndex((x) => x.id === alvo);
  if (idx >= 0) DADOS.guia[idx] = { ...DADOS.guia[idx], ...vinho }; else DADOS.guia.push(vinho);
  gravarLocal();
  if (online()) sincronizarFundo("salvarVinhoGuia", { vinho, idOriginal });
}
async function excluirVinhoGuia(id) {
  DADOS.guia = DADOS.guia.filter((x) => x.id !== id); gravarLocal();
  if (online()) sincronizarFundo("excluirVinhoGuia", { id });
}

// ======================================================================
//  CASAMENTO DE RÓTULOS  (usado ao importar planograma/vendas)
// ======================================================================
const _STOP_ROT = new Set(["vinho","tinto","branco","rose","rosado","seco","suave","doce","fino","meio","de","do","da","com","e","o","a","ml","un","und","garrafa","reserva"]);
function normTexto(s) { return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function tokensRot(s) { return normTexto(s).split(" ").filter((w) => w && w.length >= 2 && !_STOP_ROT.has(w) && !/^\d+$/.test(w)); }
// Compara códigos ignorando zeros à esquerda ("00975" == "975").
function mesmoCodigo(a, b) { a = String(a || "").trim(); b = String(b || "").trim(); if (!a || !b) return false; return a === b || a.replace(/^0+/, "") === b.replace(/^0+/, ""); }
// Acha o rótulo do estoque que corresponde a uma linha importada.
// Devolve { item, forte } — forte = casou por código ou nome idêntico (seguro).
function casarRotulo(linha) {
  const cods = [linha.codigo, linha.codigoBarras].filter(Boolean);
  // 1) por código (o planograma e as vendas usam o mesmo código do sistema)
  for (const it of DADOS.estoque) {
    const alvos = [it.codigo, it.codigoBarras, it.sku];
    if (cods.some((c) => alvos.some((a) => mesmoCodigo(c, a)))) return { item: it, forte: true };
  }
  // 2) por nome idêntico (normalizado)
  const nn = normTexto(linha.nome);
  const exato = DADOS.estoque.find((it) => normTexto(it.nome) === nn && nn);
  if (exato) return { item: exato, forte: true };
  // 3) por tokens (sugestão fraca — o usuário confirma na tela)
  const q = tokensRot(linha.nome);
  if (q.length) {
    let melhor = null, melhorScore = 0;
    for (const it of DADOS.estoque) {
      const t = new Set(tokensRot(it.nome));
      let hits = 0; q.forEach((w) => { if (t.has(w)) hits++; });
      const score = hits / q.length;
      if (score > melhorScore) { melhorScore = score; melhor = it; }
    }
    if (melhor && melhorScore >= 0.6) return { item: melhor, forte: false, semelhanca: semelhancaRotulo(linha.nome, melhor.nome) };
  }
  return { item: null, forte: false };
}
// Semelhança entre dois nomes de rótulo, de 0 a 1 — SIMÉTRICA (coeficiente de
// Dice sobre as palavras): 2×(palavras em comum) ÷ (total das duas listas).
// O score do casamento automático acima é assimétrico (só divide pelas palavras
// da venda), então "Malbec" × "Malbec Reserva Bodega Norton" dá 100% lá e 40%
// aqui. Para MOSTRAR ao usuário vale a simétrica, que não engana.
function semelhancaRotulo(a, b) {
  const ta = tokensRot(a), tb = new Set(tokensRot(b));
  if (!ta.length || !tb.size) return 0;
  let comuns = 0;
  new Set(ta).forEach((w) => { if (tb.has(w)) comuns++; });
  return (2 * comuns) / (new Set(ta).size + tb.size);
}

// ======================================================================
//  MOVIMENTOS DE ESTOQUE ↔ PDV
// ======================================================================
// Abastecer a adega: tira da retaguarda (qtd) e põe no PDV.
async function abastecerPdv(sku, pdv, qtd) {
  qtd = Number(qtd) || 0; if (qtd <= 0) return;
  const item = DADOS.estoque.find((x) => x.sku === sku); if (!item) return;
  item.qtd = Math.max(0, (Number(item.qtd) || 0) - qtd);
  garantirLinhaPdv(sku, pdv).qtd += qtd;
  gravarLocal();
  if (online()) sincronizarFundo("abastecerPdv", { sku, pdv, qtd });
}
// Ajuste direto da quantidade na adega (correção manual, +/−).
async function ajustarPdv(sku, pdv, delta) {
  const nova = Math.max(0, qtdNoPdv(sku, pdv) + delta);
  garantirLinhaPdv(sku, pdv).qtd = nova; gravarLocal();
  if (online()) sincronizarFundo("ajustarPdv", { sku, pdv, qtd: nova });
}
// Preço de venda de um rótulo NESTA adega (exceção para um vinho específico).
async function ajustarPrecoPdv(sku, pdv, preco) {
  preco = Math.max(0, Number(preco) || 0);
  garantirLinhaPdv(sku, pdv).precoVenda = preco; gravarLocal();
  if (online()) sincronizarFundo("ajustarPrecoPdv", { sku, pdv, preco });
}
// Preço PADRÃO de uma adega (vale para todos os vinhos dela, salvo exceções).
async function setPrecoPadraoAdega(pdv, preco) {
  preco = Math.max(0, Number(preco) || 0);
  const p = DADOS.pdvs.find((x) => x.nome === pdv); if (!p) return;
  p.precoPadrao = preco; gravarLocal();
  if (online()) sincronizarFundo("salvarPdv", { pdv: { nome: pdv, precoPadrao: preco }, nomeOriginal: pdv });
}
// Ajuste direto da retaguarda (+/−).
async function ajustarQtd(sku, delta) {
  const item = DADOS.estoque.find((x) => x.sku === sku); if (!item) return;
  const nova = Math.max(0, (Number(item.qtd) || 0) + delta);
  item.qtd = nova; gravarLocal();
  if (online()) sincronizarFundo("ajustarQtd", { sku, qtd: nova });
}

// --- Adegas (PDVs): criar / arquivar / reativar (otimista + sync em 2º plano) ---
async function salvarPdv(pdv, nomeOriginal) {
  const nome = String(pdv.nome || "").trim(); if (!nome) return;
  const alvo = String(nomeOriginal || nome).trim();
  const idx = DADOS.pdvs.findIndex((p) => String(p.nome).trim() === alvo);
  if (idx >= 0) DADOS.pdvs[idx] = { ...DADOS.pdvs[idx], nome: alvo, ativo: pdv.ativo || "sim", obs: pdv.obs != null ? pdv.obs : (DADOS.pdvs[idx].obs || "") };
  else DADOS.pdvs.push({ nome, ativo: pdv.ativo || "sim", obs: pdv.obs || "" });
  gravarLocal();
  if (online()) sincronizarFundo("salvarPdv", { pdv: { nome: idx >= 0 ? alvo : nome, ativo: pdv.ativo || "sim", obs: pdv.obs || "" }, nomeOriginal: nomeOriginal || null });
}
// Transferir garrafas de uma adega para outra (reusa o ajustarPdv otimista).
async function transferirEntreAdegas(sku, origem, destino, qtd) {
  qtd = Number(qtd) || 0;
  if (qtd <= 0 || !destino || origem === destino) return;
  qtd = Math.min(qtd, qtdNoPdv(sku, origem)); if (qtd <= 0) return;
  await ajustarPdv(sku, origem, -qtd);
  await ajustarPdv(sku, destino, +qtd);
}
// Devolver garrafas da adega para a retaguarda (desfaz um abastecimento).
async function devolverParaRetaguarda(sku, origem, qtd) {
  qtd = Number(qtd) || 0; if (qtd <= 0) return;
  qtd = Math.min(qtd, qtdNoPdv(sku, origem)); if (qtd <= 0) return;
  await ajustarPdv(sku, origem, -qtd);
  await ajustarQtd(sku, +qtd);
}

// ======================================================================
//  IMPORTAR — aplica as linhas já conferidas pelo usuário
//  resolvidos = [{ sku, novo, rotulo:{...}, quantAtual, minimo, nivelPar }]  (planograma)
//             = [{ sku, novo, rotulo:{...}, qtd, precoMedio, valorVendido, ... }] (vendas)
// ======================================================================
async function aplicarImportPlanograma(pdv, resolvidos) {
  // Import é pesado e faz casamento/dedup no backend → mantemos AGUARDADO e
  // autoritativo (o caller recarrega do servidor). Vai pela mesma fila serial.
  if (online()) { await enfileirar("importarPlanograma", { pdv, itens: resolvidos }); return; }
  resolvidos.forEach((r) => {
    let item = DADOS.estoque.find((x) => x.sku === r.sku);
    const novo = !item;
    if (!item) { item = { sku: r.sku, tipo: "Tinto", uva: "", produtor: "", qtd: 0, minimo: 0, precoAquisicao: 0, precoVenda: 0, fornecedor: "", dataCompra: "", obs: "" }; DADOS.estoque.push(item); }
    // Atualiza o cadastro com o que veio do sistema (sem tocar no seu custo/fornecedor).
    const d = r.rotulo || {};
    if (d.nome) item.nome = d.nome;
    if (d.codigo) item.codigo = d.codigo;
    if (d.codigoBarras) item.codigoBarras = d.codigoBarras;
    if (d.categoria) item.categoria = d.categoria;
    if (d.tipo) item.tipo = d.tipo;
    // Preço do planograma é por ADEGA (por máquina) → vai pra linha do PDV.
    // No rótulo, só seta o "padrão" quando o rótulo é NOVO (não atropela depois).
    if (novo && d.precoVenda) item.precoVenda = Number(d.precoVenda) || 0;
    const linha = garantirLinhaPdv(r.sku, pdv);
    linha.qtd = Number(r.quantAtual) || 0;
    if (r.minimo != null) linha.minimo = Number(r.minimo) || 0;
    if (r.nivelPar != null) linha.nivelPar = Number(r.nivelPar) || 0;
    if (d.precoVenda != null && d.precoVenda !== "") linha.precoVenda = Number(d.precoVenda) || 0;
  });
  gravarLocal();
}

async function aplicarImportVendas(periodo, pdv, resolvidos) {
  if (online()) { await enfileirar("importarVendas", { periodoInicio: periodo.inicio, periodoFim: periodo.fim, pdv, itens: resolvidos }); return; }
  const hoje = hojeISO();
  resolvidos.forEach((r) => {
    let item = DADOS.estoque.find((x) => x.sku === r.sku);
    if (!item && r.novo) { item = { sku: r.sku, nome: (r.rotulo && r.rotulo.nome) || "", tipo: "Tinto", uva: "", produtor: "", qtd: 0, minimo: 0, precoAquisicao: 0, precoVenda: (r.rotulo && r.rotulo.precoVenda) || 0, codigo: (r.rotulo && r.rotulo.codigo) || "", categoria: (r.rotulo && r.rotulo.categoria) || "", fornecedor: "", dataCompra: "", obs: "" }; DADOS.estoque.push(item); }
    DADOS.vendas.push({ periodoInicio: periodo.inicio, periodoFim: periodo.fim, importadoEm: hoje, pdv,
      sku: r.sku, codigo: r.codigo || "", descricao: (r.rotulo && r.rotulo.nome) || "", categoria: r.categoria || "",
      qtd: Number(r.qtd) || 0, precoMedio: Number(r.precoMedio) || 0, valorVendido: Number(r.valorVendido) || 0 });
    // Cada venda desconta do PDV.
    if (item) { const linha = garantirLinhaPdv(r.sku, pdv); linha.qtd = Math.max(0, linha.qtd - (Number(r.qtd) || 0)); }
  });
  gravarLocal();
}

// Exclui UMA venda do histórico e DEVOLVE a quantidade à adega (desfaz o desconto).
async function excluirVenda(venda) {
  const i = DADOS.vendas.indexOf(venda);
  if (i >= 0) DADOS.vendas.splice(i, 1);
  // Devolve a garrafa DE ONDE ELA SAIU (venda avulsa pode ter saído da retaguarda).
  if (venda.sku) {
    if (venda.origem === "avulsa-retaguarda") {
      const it = DADOS.estoque.find((x) => x.sku === venda.sku);
      if (it) it.qtd = (Number(it.qtd) || 0) + (Number(venda.qtd) || 0);
    } else {
      garantirLinhaPdv(venda.sku, venda.pdv).qtd += Number(venda.qtd) || 0;
    }
  }
  gravarLocal();
  if (online()) sincronizarFundo("excluirVenda", { venda });
}
// Registra uma venda que NÃO passou pelo sistema da adega (pix, encomenda).
// O período é o próprio dia da venda e o preço é o que foi cobrado de fato.
async function registrarVendaAvulsa(v) {
  const it = DADOS.estoque.find((x) => x.sku === v.sku);
  DADOS.vendas.push({
    periodoInicio: v.data, periodoFim: v.data, importadoEm: v.data, pdv: v.pdv, sku: v.sku,
    codigo: (it && it.codigo) || "", descricao: (it && it.nome) || "", categoria: (it && it.categoria) || "",
    qtd: v.qtd, precoMedio: v.preco, valorVendido: v.preco * v.qtd, origem: v.origem,
  });
  if (v.origem === "avulsa-retaguarda") {
    if (it) it.qtd = Math.max(0, (Number(it.qtd) || 0) - v.qtd);
  } else {
    const linha = garantirLinhaPdv(v.sku, v.pdv);
    linha.qtd = Math.max(0, linha.qtd - v.qtd);
  }
  gravarLocal();
  if (online()) {
    sincronizarFundo("registrarVendaManual", { venda: {
      data: v.data, pdv: v.pdv, sku: v.sku, qtd: v.qtd, precoMedio: v.preco,
      valorVendido: v.preco * v.qtd, origem: v.origem,
      codigo: (it && it.codigo) || "", descricao: (it && it.nome) || "", categoria: (it && it.categoria) || "",
    } });
  }
}
// Exclui TODAS as vendas de um período (pdv+início+fim) e devolve à adega.
// Aguardado (via fila) porque é usado na SUBSTITUIÇÃO de período no import:
// se a remoção falhar, o import não roda (evita duplicar no servidor).
async function excluirVendasPeriodo(pdv, inicio, fim) {
  const alvo = DADOS.vendas.filter((v) => v.pdv === pdv && v.periodoInicio === inicio && v.periodoFim === fim);
  if (online()) { await enfileirar("excluirVendasPeriodo", { pdv, periodoInicio: inicio, periodoFim: fim }); }
  else {
    alvo.forEach((v) => { if (v.sku) garantirLinhaPdv(v.sku, v.pdv).qtd += Number(v.qtd) || 0; });
    DADOS.vendas = DADOS.vendas.filter((v) => !(v.pdv === pdv && v.periodoInicio === inicio && v.periodoFim === fim));
    gravarLocal();
  }
  return alvo.length;
}


// ======================================================================
//  RENDER — ESTOQUE
// ======================================================================
function itensFiltrados() {
  const q = filtro.busca.trim().toLowerCase();
  return DADOS.estoque.filter((v) => {
    if (filtro.tipo && v.tipo !== filtro.tipo) return false;
    if (filtro.baixo && !precisaRepor(v)) return false;
    if (q) {
      const alvo = `${v.nome} ${v.uva} ${v.produtor} ${v.fornecedor} ${v.sku} ${v.codigo || ""} ${v.codigoBarras || ""}`.toLowerCase();
      if (!alvo.includes(q)) return false;
    }
    return true;
  });
}
// "Precisa repor a adega": está na adega atual em quantidade <= mínimo crítico.
const precisaRepor = (v) => { const m = minimoPdv(v.sku, pdvAtual); return m > 0 && qtdNoPdv(v.sku, pdvAtual) <= m; };
const semRetaguarda = (v) => (Number(v.qtd) || 0) <= 0;

function renderResumo() {
  const est = DADOS.estoque;
  const naAdega = est.reduce((s, v) => s + qtdNoPdv(v.sku, pdvAtual), 0);
  const retaguarda = est.reduce((s, v) => s + (Number(v.qtd) || 0), 0);
  const repor = est.filter(precisaRepor).length;
  $("#painel-resumo").innerHTML = `
    <div class="resumo-caixa"><span class="num">${naAdega}</span><span class="rot">na adega</span></div>
    <div class="resumo-caixa"><span class="num">${retaguarda}</span><span class="rot">retaguarda</span></div>
    <div class="resumo-caixa ${repor ? "alerta" : ""}"><span class="num">${repor}</span><span class="rot">repor</span></div>`;
}

// Barra de seleção da adega. Sempre mostra a atual + um botão "⚙ adegas"
// (criar/arquivar/reativar). Com 2+ adegas ativas, mostra os chips para trocar.
function renderSeletorPdv() {
  const cont = $("#pdv-seletor"); if (!cont) return;
  const ativas = pdvsAtivos();
  cont.innerHTML = "";
  cont.classList.toggle("solo", ativas.length <= 1);
  if (ativas.length <= 1) {
    cont.appendChild(el("span", "pdv-atual-solo", "🏬 " + escaparHtml(pdvAtual || (ativas[0] && ativas[0].nome) || "Adega")));
  } else {
    ativas.forEach((p) => {
      const b = el("button", "pdv-chip" + (p.nome === pdvAtual ? " ativo" : ""), "🏬 " + escaparHtml(p.nome));
      b.addEventListener("click", () => { pdvAtual = p.nome; renderEstoque(); });
      cont.appendChild(b);
    });
  }
  const ger = el("button", "pdv-chip pdv-ger", "⚙ adegas");
  ger.addEventListener("click", abrirModalAdegas);
  cont.appendChild(ger);
}

// --- Modal: gerenciar adegas (criar / arquivar / reativar) ---
function abrirModalAdegas() { renderListaAdegas(); abrir("#modal-adegas"); }
function renderListaAdegas() {
  const cont = $("#lista-adegas"); if (!cont) return;
  cont.innerHTML = "";
  (DADOS.pdvs || []).forEach((p) => {
    const ativa = pdvAtivoBool(p);
    const nGarrafas = DADOS.pdvEstoque.filter((r) => r.pdv === p.nome).reduce((s, r) => s + (Number(r.qtd) || 0), 0);
    const row = el("div", "adega-row" + (ativa ? "" : " arquivada"));
    row.innerHTML = `
      <div class="adega-info">
        <span class="adega-nome">🏬 ${escaparHtml(p.nome)}</span>
        <span class="adega-tag">${ativa ? "ativa" : "arquivada"} · ${nGarrafas} ${nGarrafas === 1 ? "garrafa" : "garrafas"}</span>
      </div>
      <button class="btn-secundario adega-toggle">${ativa ? "Arquivar" : "Reativar"}</button>`;
    row.querySelector(".adega-toggle").addEventListener("click", async () => {
      if (ativa && pdvsAtivos().length <= 1) { toast("Deixe ao menos uma adega ativa"); return; }
      await comProgresso(() => salvarPdv({ nome: p.nome, ativo: ativa ? "nao" : "sim", obs: p.obs || "" }, p.nome));
      if (ativa && pdvAtual === p.nome) { const a = pdvsAtivos(); if (a[0]) pdvAtual = a[0].nome; }
      renderListaAdegas(); renderEstoque();
      toast(ativa ? `Adega "${p.nome}" arquivada` : `Adega "${p.nome}" reativada ✓`);
    });
    cont.appendChild(row);
  });
}
$("#btn-nova-adega").addEventListener("click", async () => {
  const inp = $("#nova-adega-nome");
  const nome = inp.value.trim();
  if (!nome) { toast("Escreva o nome da adega"); inp.focus(); return; }
  if ((DADOS.pdvs || []).some((p) => String(p.nome).trim().toLowerCase() === nome.toLowerCase())) { toast("Já existe uma adega com esse nome"); return; }
  await comProgresso(() => salvarPdv({ nome, ativo: "sim" }));
  inp.value = ""; renderListaAdegas(); renderEstoque();
  toast(`Adega "${nome}" criada ✓`);
});

// --- Tela: Preços por adega (edita o preço de cada vinho numa adega, num lugar só) ---
function abrirModalPrecos() {
  const sel = $("#precos-pdv");
  sel.innerHTML = opcoesPdv(pdvAtual);
  renderPrecosLista(sel.value || pdvAtual);
  abrir("#modal-precos");
}
function renderPrecosLista(pdv) {
  const cont = $("#precos-lista"); if (!cont) return;
  // Campo do preço padrão da adega.
  const inpPadrao = $("#preco-padrao-adega");
  const padraoAdega = precoPadraoAdega(pdv);
  if (inpPadrao) inpPadrao.value = padraoAdega > 0 ? padraoAdega : "";
  cont.innerHTML = "";
  const lista = (DADOS.estoque || []).slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
  if (!lista.length) { cont.innerHTML = `<p class="dica">Cadastre vinhos no estoque primeiro.</p>`; return; }
  const dicaPadrao = padraoAdega > 0 ? String(padraoAdega).replace(".", ",") : "sem preço";
  lista.forEach((v) => {
    const lp = linhaPdv(v.sku, pdv);
    const override = (lp && lp.precoVenda > 0) ? lp.precoVenda : "";
    const row = el("div", "preco-row");
    row.innerHTML = `
      <span class="preco-nome">${escaparHtml(v.nome || "(sem nome)")}</span>
      <div class="preco-campo">R$ <input type="number" min="0" step="0.01" inputmode="decimal" value="${override}" placeholder="${dicaPadrao}" /></div>`;
    const inp = row.querySelector("input");
    inp.addEventListener("change", () => { ajustarPrecoPdv(v.sku, pdv, Number(inp.value) || 0); });
    cont.appendChild(row);
  });
}
$("#btn-precos-adega").addEventListener("click", abrirModalPrecos);
$("#precos-pdv").addEventListener("change", (e) => renderPrecosLista(e.target.value));
// Preço padrão da adega: aplica a todos os vinhos (menos exceções) e atualiza os placeholders.
$("#preco-padrao-adega").addEventListener("change", async (e) => {
  const pdv = $("#precos-pdv").value || pdvAtual;
  await setPrecoPadraoAdega(pdv, Number(e.target.value) || 0);
  renderPrecosLista(pdv);
});

function classeTipo(t) { return { Tinto: "tag-tinto", Branco: "tag-branco", "Rosé": "tag-rose", Espumante: "tag-espumante" }[t] || "tag-tinto"; }

function renderEstoque() {
  renderResumo();
  renderSeletorPdv();
  const lista = itensFiltrados();
  const grade = $("#grade");
  const vazio = $("#vazio-estoque");
  grade.innerHTML = "";
  grade.classList.toggle("modo-selecao", modoSelecao);
  $("#resultado-info").textContent = `${lista.length} ${lista.length === 1 ? "rótulo" : "rótulos"}`;
  $("#btn-selecionar").classList.toggle("hidden", modoSelecao || DADOS.estoque.length === 0);

  if (DADOS.estoque.length === 0) { vazio.classList.remove("hidden"); return; }
  vazio.classList.add("hidden");

  lista.forEach((v) => {
    const sel = modoSelecao && selecionados.has(v.sku);
    const repor = precisaRepor(v);
    const item = el("div", "item" + (repor ? " baixo" : "") + (sel ? " selecionado" : ""));
    const naAdega = qtdNoPdv(v.sku, pdvAtual);
    const retag = Number(v.qtd) || 0;
    const precoVendaAdega = precoVendaNoPdv(v.sku, pdvAtual);
    const margem = precoVendaAdega - (Number(v.precoAquisicao) || 0);
    const metaPreco = precoVendaAdega ? `<span>Venda: <b>${brl(precoVendaAdega)}</b></span>` : "";
    const metaCusto = v.precoAquisicao ? `<span>Custo: <b>${brl(v.precoAquisicao)}</b></span>` : "";
    const metaMargem = (precoVendaAdega && v.precoAquisicao)
      ? `<span class="${margem >= 0 ? "lucro" : "prejuizo"}">Margem: <b>${brl(margem)}</b></span>`
      : `<span>Fornec.: <b>${escaparHtml(v.fornecedor || "—")}</b></span>`;
    item.innerHTML = `
      <div class="item-check"></div>
      <div class="item-info">
        <div><span class="tag-tipo ${classeTipo(v.tipo)}">${v.tipo || "—"}</span>
          ${repor ? '<span class="selo-baixo">⚠ Repor adega</span>' : ""}</div>
        <div class="item-nome">${escaparHtml(v.nome || "(sem nome)")}</div>
        <div class="item-linha2">${[v.uva, v.produtor].filter(Boolean).map(escaparHtml).join(" · ") || "&nbsp;"}</div>
        <div class="item-meta">${metaPreco}${metaCusto}${metaMargem}</div>
      </div>
      <div class="item-estoques">
        <div class="est-bloco est-adega">
          <div class="est-rot">Adega</div>
          <div class="est-linha">
            <button class="qtd-btn menos" aria-label="Vendeu/tirou 1 da adega">−</button>
            <span class="est-num">${naAdega}</span>
            <button class="qtd-btn mais" aria-label="Aumentar na adega">+</button>
          </div>
          <button class="btn-mover" ${naAdega <= 0 ? "disabled" : ""}>⇄ Mover</button>
        </div>
        <div class="est-bloco est-retag">
          <div class="est-rot">Retaguarda</div>
          <div class="est-linha">
            <button class="qtd-btn menos-r" aria-label="Diminuir retaguarda">−</button>
            <span class="est-num secundario">${retag}</span>
            <button class="qtd-btn mais-r" aria-label="Aumentar retaguarda">+</button>
          </div>
          <button class="btn-abastecer" ${retag <= 0 ? "disabled" : ""}>↑ Abastecer adega</button>
        </div>
      </div>`;
    if (modoSelecao) {
      item.querySelector(".item-info").addEventListener("click", () => alternarSelecao(v.sku));
    } else {
      item.querySelector(".item-info").addEventListener("click", () => abrirModalItem(v));
      item.querySelector(".menos").addEventListener("click", async () => { await ajustarPdv(v.sku, pdvAtual, -1); renderEstoque(); });
      item.querySelector(".mais").addEventListener("click", async () => { await ajustarPdv(v.sku, pdvAtual, +1); renderEstoque(); });
      item.querySelector(".menos-r").addEventListener("click", async () => { await ajustarQtd(v.sku, -1); renderEstoque(); });
      item.querySelector(".mais-r").addEventListener("click", async () => { await ajustarQtd(v.sku, +1); renderEstoque(); });
      const ab = item.querySelector(".btn-abastecer");
      if (ab && retag > 0) ab.addEventListener("click", () => abrirModalAbastecer(v));
      const mv = item.querySelector(".btn-mover");
      if (mv && naAdega > 0) mv.addEventListener("click", () => abrirModalMover(v));
    }
    grade.appendChild(item);
  });
}

// ---- Seleção múltipla + exclusão em massa (aba Estoque) ----
let modoSelecao = false;
const selecionados = new Set();

function alternarSelecao(sku) {
  if (selecionados.has(sku)) selecionados.delete(sku); else selecionados.add(sku);
  renderEstoque(); atualizarBarraSelecao();
}
function atualizarBarraSelecao() {
  const n = selecionados.size;
  $("#selecao-info").textContent = n ? `${n} selecionada${n === 1 ? "" : "s"}` : "Toque nas garrafas para selecionar";
  $("#btn-selecao-excluir").disabled = n === 0;
}
function entrarSelecao() {
  modoSelecao = true; selecionados.clear();
  $("#selecao-barra").classList.remove("hidden");
  renderEstoque(); atualizarBarraSelecao();
}
function sairSelecao() {
  modoSelecao = false; selecionados.clear();
  $("#selecao-barra").classList.add("hidden");
  renderEstoque();
}
$("#btn-selecionar").addEventListener("click", entrarSelecao);
$("#btn-selecao-cancelar").addEventListener("click", sairSelecao);
$("#btn-selecao-excluir").addEventListener("click", async () => {
  const skus = [...selecionados];
  if (!skus.length) return;
  if (!confirm(`Excluir ${skus.length} ${skus.length === 1 ? "garrafa" : "garrafas"} do estoque?`)) return;
  await comProgresso(async () => { for (const sku of skus) await excluirItem(sku); });
  modoSelecao = false; selecionados.clear();
  $("#selecao-barra").classList.add("hidden");
  await recarregar();
  toast(`${skus.length} ${skus.length === 1 ? "garrafa excluída" : "garrafas excluídas"}`);
});

// ======================================================================
//  RENDER — COMPRAS
// ======================================================================
function renderCompras() {
  const lista = DADOS.compras;
  const cont = $("#lista-compras");
  cont.innerHTML = "";
  const total = lista.reduce((s, c) => s + (Number(c.qtd) || 0) * (Number(c.precoUnit) || 0), 0);
  $("#compras-info").textContent = lista.length ? `${lista.length} compras · ${brl(total)} no total` : "";
  $("#vazio-compras").classList.toggle("hidden", lista.length > 0);

  lista.forEach((c) => {
    const totalC = (Number(c.qtd) || 0) * (Number(c.precoUnit) || 0);
    const card = el("div", "compra");
    card.innerHTML = `
      <div class="compra-topo">
        <span class="compra-nome">${c.nome}</span>
        <span class="compra-total">${brl(totalC)}</span>
        <button class="compra-x" aria-label="Excluir compra" title="Excluir compra">✕</button>
      </div>
      <div class="compra-sub">${c.qtd} un. × ${brl(c.precoUnit)} · ${c.fornecedor || "sem fornecedor"} · ${dataBR(c.data)}</div>`;
    card.querySelector(".compra-x").addEventListener("click", async () => {
      if (!confirm("Excluir esta compra do histórico?\n(não altera o estoque — ajuste com +/− se precisar)")) return;
      await comProgresso(() => excluirCompra(c));
      await recarregar(); toast("Compra excluída");
    });
    cont.appendChild(card);
  });
}

// ======================================================================
//  RENDER — PREÇOS (radar por vinho: o que você paga em cada fornecedor)
// ======================================================================
const filtroOfertas = { soSubiu: false };

// Histórico de preço pago (das Compras) de um vinho, do mais antigo ao mais novo.
function historicoFornecedor(nome) {
  const chave = String(nome || "").toLowerCase().trim();
  return DADOS.compras
    .filter((c) => String(c.nome || "").toLowerCase().trim() === chave)
    .map((c) => ({ data: c.data || "", preco: Number(c.precoUnit) || 0, fornecedor: (c.fornecedor || "").trim() }))
    .filter((c) => c.preco > 0)
    .sort((a, b) => String(a.data).localeCompare(String(b.data)));
}

// Lista de preços públicos (da busca mais recente) de um vinho — uma oferta por
// loja, ranqueada da mais barata para a mais cara.
function publicoDe(nome) {
  const chave = String(nome || "").toLowerCase().trim();
  const achados = (DADOS.precos || []).filter((p) => String(p.consulta || "").toLowerCase().trim() === chave && Number(p.preco) > 0);
  if (!achados.length) return [];
  const ultimaData = achados.map((p) => String(p.data || "")).sort().slice(-1)[0];
  const doDia = achados.filter((p) => String(p.data || "") === ultimaData);
  const porSite = {};
  doDia.forEach((p) => { const s = p.site || ""; if (!porSite[s] || Number(p.preco) < Number(porSite[s].preco)) porSite[s] = p; });
  return Object.keys(porSite).map((s) => porSite[s]).sort((a, b) => Number(a.preco) - Number(b.preco));
}

// Consolida o que sabemos sobre o preço de um item do estoque.
function precoDoItem(item) {
  const h = historicoFornecedor(item.nome);
  const vals = h.map((c) => c.preco);
  const atual = vals.length ? vals[vals.length - 1] : (Number(item.precoAquisicao) || 0);
  const anterior = vals.length > 1 ? vals[vals.length - 2] : 0;
  const min = vals.length ? Math.min(...vals) : atual;
  const fornecedor = (h.length ? h[h.length - 1].fornecedor : "") || item.fornecedor || "";
  const subiu = anterior > 0 && atual > anterior;
  const caiu = anterior > 0 && atual < anterior;
  const deltaPct = anterior > 0 ? Math.round(((atual - anterior) / anterior) * 100) : 0;
  const deltaRs = anterior > 0 ? atual - anterior : 0;
  return { h, vals, atual, anterior, min, fornecedor, subiu, caiu, deltaPct, deltaRs, compras: h.length };
}

function sparkline(vals) {
  if (vals.length < 2) return "";
  const ult = vals.slice(-14);
  const min = Math.min(...ult), max = Math.max(...ult), rng = max - min || 1;
  const barras = ult.map((v) => {
    const alt = 6 + Math.round(((v - min) / rng) * 22); // 6..28px
    return `<span class="spark-bar" style="height:${alt}px" title="${brl(v)}"></span>`;
  }).join("");
  return `<div class="spark">${barras}</div>`;
}

function montarFiltrosOfertas() {
  const cont = $("#ofertas-filtros");
  cont.innerHTML = "";
  const chip = el("button", "chip chip-baixo", "⚠ Subiu de preço");
  chip.addEventListener("click", () => {
    filtroOfertas.soSubiu = !filtroOfertas.soSubiu;
    chip.classList.toggle("ativo", filtroOfertas.soSubiu);
    renderOfertas();
  });
  cont.appendChild(chip);
}

// Dispara a varredura de preço público no backend (Buscapé) e recarrega.
$("#btn-buscar-publico").addEventListener("click", async () => {
  if (!online()) { toast("A busca de preços roda no servidor — conecte à planilha primeiro"); return; }
  if (!DADOS.estoque.length) { toast("Cadastre vinhos no estoque primeiro"); return; }
  $("#carregando-msg").textContent = "Procurando preços públicos (pode levar 1–2 min)…";
  abrir("#carregando");
  try {
    const r = await apiPost("varrerAgora", {});
    await carregar();
    fechar("#carregando"); renderOfertas();
    const n = (r && r.oportunidades) ? r.oportunidades.length : 0;
    const achados = (r && r.achados) || 0;
    toast(n ? `${n} vinho(s) mais baratos no varejo 💰` : `Preços atualizados · ${achados} rótulos encontrados`);
  } catch (err) {
    fechar("#carregando"); console.error(err);
    toast("Não consegui buscar: " + (err.message || "tente de novo"));
  }
});

// --- Modal Lojas de confiança ---
$("#btn-lojas").addEventListener("click", () => { renderLojas(); $("#loja-status").textContent = ""; $("#form-loja").reset(); abrir("#modal-lojas"); });

function renderLojas() {
  const cont = $("#lista-lojas");
  const lojas = DADOS.lojas || [];
  if (!lojas.length) { cont.innerHTML = `<p class="dica">Nenhuma loja ainda. Adicione abaixo.</p>`; return; }
  cont.innerHTML = "";
  lojas.forEach((l) => {
    const div = el("div", "loja-item");
    div.innerHTML = `<div><div class="loja-nome">${escaparHtml(l.nome || siteDe(l.url))}</div>
      <div class="loja-url">${escaparHtml(siteDe(l.url))}</div></div>
      <button type="button" class="loja-x" aria-label="Remover">✕</button>`;
    div.querySelector(".loja-x").addEventListener("click", async () => {
      if (!confirm("Remover esta loja do radar?")) return;
      await comProgresso(() => excluirLoja(l.url));
      renderLojas(); toast("Loja removida");
    });
    cont.appendChild(div);
  });
}

$("#form-loja").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const url = f.url.value.trim();
  if (!/^https?:\/\//i.test(url)) { $("#loja-status").textContent = "Cole o endereço completo (com https://)."; return; }
  const loja = { url, nome: f.nome.value.trim() || siteDe(url), ativo: "sim" };
  await comProgresso(() => salvarLoja(loja, null));
  f.reset(); renderLojas(); toast("Loja adicionada ✓");
});

function renderOfertas() {
  const cont = $("#lista-ofertas");
  cont.innerHTML = "";
  const dados = DADOS.estoque.map((it) => ({ item: it, p: precoDoItem(it) }));
  const subiram = dados.filter((d) => d.p.subiu).length;
  let lista = dados;
  if (filtroOfertas.soSubiu) lista = lista.filter((d) => d.p.subiu);
  // Ordena: quem subiu primeiro (alerta no topo), depois por nome.
  lista.sort((a, b) => (b.p.subiu - a.p.subiu) || String(a.item.nome).localeCompare(String(b.item.nome)));

  $("#ofertas-info").textContent = dados.length
    ? `${dados.length} ${dados.length === 1 ? "vinho" : "vinhos"}${subiram ? ` · ${subiram} subiu de preço` : ""}`
    : "";
  $("#vazio-ofertas").classList.toggle("hidden", dados.length > 0);
  if (!dados.length) return;

  lista.forEach(({ item, p }) => {
    const card = el("div", "oferta" + (p.subiu ? " subiu" : p.caiu ? " baixou" : ""));
    let varHtml = "";
    if (p.anterior) {
      const cls = p.caiu ? "desce" : p.subiu ? "sobe" : "igual";
      const seta = p.caiu ? "▼" : p.subiu ? "▲" : "•";
      const sinal = p.deltaRs > 0 ? "+" : "";
      varHtml = `<div class="oferta-var ${cls}">${seta} ${sinal}${brl(p.deltaRs)} <small>vs. compra anterior</small></div>`;
    }
    const selo = p.subiu ? '<span class="oferta-subiu-selo">▲ Subiu — reveja</span>'
      : p.caiu ? '<span class="oferta-baixou-selo">▼ Baixou</span>' : "";
    const rodape = p.compras > 1
      ? `<span class="oferta-min">Menor pago: <b>${brl(p.min)}</b>${p.atual <= p.min ? " · é o menor 👍" : ""}</span>`
      : p.compras === 1
        ? `<span class="oferta-min">1ª compra registrada</span>`
        : `<span class="oferta-min">Sem compra registrada (preço do cadastro)</span>`;
    const contagem = p.compras ? `<span class="oferta-compras">${p.compras} ${p.compras === 1 ? "compra" : "compras"}</span>` : "";
    // Ranking de preços públicos (várias lojas), quando houver.
    const ofertas = publicoDe(item.nome);
    let pubHtml = "";
    if (ofertas.length) {
      const menor = ofertas[0];
      const barato = p.atual && Number(menor.preco) < p.atual;
      const linhas = ofertas.slice(0, 5).map((o, i) => {
        const abaixo = p.atual && Number(o.preco) < p.atual;
        return `<a class="op-loja${abaixo ? " bom" : ""}" href="${escaparAttr(o.url)}" target="_blank" rel="noopener" title="${escaparAttr(o.achado || "")}">
          <span class="opl-site">${i === 0 ? "🏆 " : ""}${escaparHtml(o.site || "?")}</span>
          <span class="opl-preco">${brl(o.preco)}</span></a>`;
      }).join("");
      pubHtml = `<div class="oferta-publico${barato ? " bom" : ""}">
        <div class="op-titulo">🌐 Preços públicos${ofertas.length > 1 ? ` · ${ofertas.length} lojas` : ""}</div>
        ${linhas}
        ${barato ? `<div class="op-flag">💰 menor está ${brl(p.atual - Number(menor.preco))} abaixo do que você paga</div>` : ""}
      </div>`;
    }
    card.innerHTML = `
      <div class="oferta-topo">
        <div>
          <div class="oferta-nome">${escaparHtml(item.nome || "(sem nome)")}</div>
          <div class="oferta-site">Você paga: <b>${p.atual ? brl(p.atual) : "—"}</b>${p.fornecedor ? " · " + escaparHtml(p.fornecedor) : ""}</div>
          ${selo}
        </div>
        <div class="oferta-preco">${p.atual ? `<div class="atual">${brl(p.atual)}</div>` : `<div class="semdados">sem preço</div>`}${varHtml}</div>
      </div>
      ${sparkline(p.vals)}
      ${pubHtml}
      <div class="oferta-rodape">
        ${rodape}
        ${contagem}
      </div>`;
    card.querySelector(".oferta-nome").addEventListener("click", () => abrirModalItem(item));
    cont.appendChild(card);
  });
}

// ======================================================================
//  MODAL — ITEM
// ======================================================================
function abrirModalItem(item) {
  const f = $("#form-item");
  f.reset();
  const editando = !!item;
  $("#modal-item-titulo").textContent = editando ? "Editar garrafa" : "Nova garrafa";
  $("#btn-excluir-item").classList.toggle("hidden", !editando);
  f.sku_original.value = editando ? item.sku : "";
  if (editando) {
    f.nome.value = item.nome || ""; f.tipo.value = item.tipo || "Tinto"; f.uva.value = item.uva || "";
    f.produtor.value = item.produtor || ""; f.sku.value = item.sku || ""; f.qtd.value = item.qtd ?? 0;
    f.minimo.value = item.minimo ?? 3; f.precoAquisicao.value = item.precoAquisicao || "";
    f.dataCompra.value = (item.dataCompra || "").slice(0, 10); f.fornecedor.value = item.fornecedor || "";
    f.obs.value = item.obs || "";
    if (f.codigo) f.codigo.value = item.codigo || "";
    if (f.precoVenda) f.precoVenda.value = item.precoVenda || "";
  } else { f.dataCompra.value = hojeISO(); }
  atualizarDatalists();
  abrir("#modal-item");
}

$("#form-item").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  // Parte do item existente (se editando) para não perder campos que vieram do
  // sistema (código de barras, categoria, nível de par) e não estão no formulário.
  const orig = DADOS.estoque.find((x) => x.sku === (f.sku_original.value || f.sku.value.trim())) || {};
  const item = {
    ...orig,
    sku: f.sku.value.trim(), nome: f.nome.value.trim(), tipo: f.tipo.value, uva: f.uva.value.trim(),
    produtor: f.produtor.value.trim(), qtd: Number(f.qtd.value) || 0, minimo: Number(f.minimo.value) || 0,
    precoAquisicao: Number(f.precoAquisicao.value) || 0, dataCompra: f.dataCompra.value,
    fornecedor: f.fornecedor.value.trim(), obs: f.obs.value.trim(),
    codigo: f.codigo ? f.codigo.value.trim() : (orig.codigo || ""),
    precoVenda: f.precoVenda ? (Number(f.precoVenda.value) || 0) : (orig.precoVenda || 0),
  };
  delete item.__row;
  if (!item.nome) return;
  await comProgresso(() => salvarItem(item, f.sku_original.value || null));
  fechar("#modal-item"); await recarregar(); toast("Garrafa salva ✓");
});

$("#btn-excluir-item").addEventListener("click", async () => {
  const sku = $("#form-item").sku_original.value;
  if (!sku) return;
  if (!confirm("Excluir esta garrafa do estoque?")) return;
  await comProgresso(() => excluirItem(sku));
  fechar("#modal-item"); await recarregar(); toast("Garrafa excluída");
});

// ======================================================================
//  MODAL — COMPRA
// ======================================================================
function abrirModalCompra() {
  const f = $("#form-compra");
  f.reset(); f.data.value = hojeISO();
  $("#dica-compra").textContent = online()
    ? "A compra entra no histórico e soma no estoque automaticamente."
    : "Modo demonstração: fica salvo só neste aparelho.";
  atualizarDatalists();
  abrir("#modal-compra");
}

$("#form-compra").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const compra = {
    nome: f.nome.value.trim(), qtd: Number(f.qtd.value) || 0, precoUnit: Number(f.precoUnit.value) || 0,
    fornecedor: f.fornecedor.value.trim(), data: f.data.value, notaChave: f.notaChave.value.trim(),
  };
  if (!compra.nome || compra.qtd < 1) return;
  await comProgresso(() => registrarCompra(compra));
  fechar("#modal-compra"); await recarregar(); irPara("estoque"); toast("Compra registrada ✓");
});

function atualizarDatalists() {
  $("#lista-fornecedores").innerHTML = DADOS.fornecedores.map((f) => `<option value="${(f.nome || f)}">`).join("");
  $("#lista-vinhos").innerHTML = DADOS.estoque.map((v) => `<option value="${v.nome}">`).join("");
}

// ======================================================================
//  LER NOTA FISCAL COM IA (Gemini) — foto da câmera ou PDF
// ======================================================================
$("#btn-ler-nota").addEventListener("click", () => {
  if (!GEMINI_KEY) {
    toast("Configure a chave da IA na engrenagem ⚙ primeiro");
    $("#btn-config").click();
    return;
  }
  $("#input-nota").click(); // abre a câmera / seletor de arquivo
});

$("#input-nota").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // permite reenviar o mesmo arquivo depois
  if (!file) return;
  try {
    const { base64, mime } = await prepararArquivo(file);
    $("#carregando-msg").textContent = "Lendo a nota com a IA…";
    abrir("#carregando");
    const nota = await lerNotaIA(base64, mime);
    fechar("#carregando");
    abrirModalNota(nota);
  } catch (err) {
    fechar("#carregando");
    console.error(err);
    toast("Não consegui ler: " + (err.message || "tente outra foto"));
  }
});

// Lê o arquivo em base64. Fotos são reduzidas (mais rápido e barato); PDF vai inteiro.
function prepararArquivo(file) {
  return new Promise((resolve, reject) => {
    const ehImagem = file.type.startsWith("image/");
    if (!ehImagem) {
      const r = new FileReader();
      r.onload = () => resolve({ base64: String(r.result).split(",")[1], mime: file.type || "application/pdf" });
      r.onerror = reject;
      r.readAsDataURL(file);
      return;
    }
    // Imagem: redimensiona para no máx. 1600px no maior lado.
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1600;
        let { width: w, height: h } = img;
        if (w > max || h > max) { const escala = max / Math.max(w, h); w = Math.round(w * escala); h = Math.round(h * escala); }
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve({ base64: cv.toDataURL("image/jpeg", 0.85).split(",")[1], mime: "image/jpeg" });
      };
      img.onerror = reject;
      img.src = r.result;
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Chama o Gemini direto do celular (a chave fica só no aparelho).
async function lerNotaIA(base64, mime) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_IA}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const instrucao =
    "Esta é uma nota fiscal ou cupom de compra de vinhos/bebidas. Extraia os itens comprados. " +
    "Responda em JSON no formato: {\"fornecedor\":\"\",\"data\":\"AAAA-MM-DD\",\"numero\":\"\",\"chave\":\"\",\"itens\":[{\"nome\":\"\",\"codigoBarras\":\"\",\"qtd\":0,\"precoUnit\":0}]}. " +
    "nome = descrição do produto (limpa, sem códigos). codigoBarras = o código de barras EAN/GTIN do item (geralmente 13 dígitos; use \"\" se não aparecer). " +
    "qtd = quantidade (número). precoUnit = valor unitário em reais (número, ponto decimal). " +
    "numero = o número da nota fiscal/cupom (só o número, ex.: \"012345\"; use \"\" se não achar). " +
    "chave = a chave de acesso da NF-e (44 dígitos), se aparecer; senão \"\". " +
    "Se o fornecedor/emitente aparecer, preencha; senão deixe vazio. Se a data aparecer, use AAAA-MM-DD. Ignore itens que não sejam produtos (frete, impostos, totais).";
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: instrucao }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  };
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || "erro da IA");
  const texto = json.candidates && json.candidates[0] && json.candidates[0].content
    && json.candidates[0].content.parts && json.candidates[0].content.parts[0].text;
  if (!texto) throw new Error("a IA não retornou itens");
  let dados; try { dados = JSON.parse(texto); } catch (_) { throw new Error("resposta da IA fora do formato"); }
  return dados;
}

// ---- Trava de nota duplicada ----
// Deriva a chave de deduplicação do campo "Nº da nota". Se tiver 44 dígitos, é
// a chave de acesso da NF-e (única no país). Senão, é o número da nota (que
// pode repetir entre fornecedores → só conta como duplicata no MESMO fornecedor).
function chaveNota(idField) {
  const s = String(idField || "").trim(); if (!s) return "";
  const dig = s.replace(/\D/g, "");
  if (dig.length >= 44) return "C:" + dig.slice(-44);
  return "N:" + s;
}
// Procura uma compra já lançada com a mesma nota. Devolve a compra ou null.
function notaDuplicada(idField, fornecedor) {
  const key = chaveNota(idField); if (!key) return null;
  const ehChave = key.indexOf("C:") === 0;
  return (DADOS.compras || []).find((c) => {
    if (!c.notaChave || c.notaChave !== key) return false;
    return ehChave ? true : normTexto(c.fornecedor) === normTexto(fornecedor);
  }) || null;
}
function verificarNotaDup() {
  const f = $("#form-nota"); const aviso = $("#nota-dup-aviso"); if (!aviso) return;
  const dup = notaDuplicada(f.numero ? f.numero.value : "", f.fornecedor.value);
  if (dup) {
    aviso.innerHTML = `⚠ Esta nota já foi lançada em <b>${dataBR(dup.data)}</b>. Salvar de novo vai <b>duplicar o estoque</b> (as quantidades somam de novo).`;
    aviso.classList.remove("hidden");
  } else { aviso.classList.add("hidden"); }
}

// ---- Modal de conferência dos itens lidos ----
let confNota = null;
function abrirModalNota(nota) {
  const f = $("#form-nota");
  f.reset();
  f.fornecedor.value = nota.fornecedor || "";
  f.data.value = (nota.data && /^\d{4}-\d{2}-\d{2}$/.test(nota.data)) ? nota.data : hojeISO();
  if (f.numero) f.numero.value = nota.chave || nota.numero || "";
  const itens = Array.isArray(nota.itens) && nota.itens.length ? nota.itens : [{}];
  const reserv = new Set();
  confNota = { linhas: itens.map((it) => linhaNotaModelo(it, reserv)) };
  renderNotaItens();
  verificarNotaDup();
  atualizarDatalists();
  abrir("#modal-nota");
}
// Cria o modelo de uma linha da nota, já com a sugestão de casamento.
function linhaNotaModelo(it, reserv) {
  const l = { nome: it.nome || "", qtd: Number(it.qtd) || 0, precoUnit: Number(it.precoUnit) || 0, codigoBarras: it.codigoBarras || "" };
  rematchNota(l, reserv);
  return l;
}
// (Re)calcula com qual rótulo do estoque esta linha casa.
function rematchNota(l, reserv) {
  const m = casarRotulo({ codigoBarras: l.codigoBarras || "", codigo: "", nome: l.nome || "" });
  l.skuAlvo = m.item ? m.item.sku : "";
  l.nomeAlvo = m.item ? m.item.nome : "";
  l.forte = m.forte;
  l.criarNovo = !m.item;
  if (!m.item) l.skuNovo = gerarSku(l.nome || "item", reserv || new Set(confNota.linhas.map((x) => x.skuNovo).filter(Boolean)));
}
function renderNotaItens() {
  const cont = $("#nota-itens");
  cont.innerHTML = `<div class="nota-cab"><span>Produto</span><span>Qtd</span><span>Unit. R$</span><span></span></div>`;
  confNota.linhas.forEach((l, idx) => {
    const casou = !l.criarNovo && l.skuAlvo;
    const badge = casou
      ? `<span class="conf-badge ${l.forte ? "ok" : "fraco"}">→ ${escaparHtml(l.nomeAlvo)}${l.forte ? "" : " ?"}</span>`
      : `<span class="conf-badge novo">＋ novo rótulo</span>`;
    const div = el("div", "nota-item-bloco");
    div.innerHTML = `
      <div class="nota-item">
        <input class="i-nome" type="text" value="${escaparAttr(l.nome)}" placeholder="Nome do vinho" />
        <input class="i-qtd" type="number" min="0" step="1" inputmode="numeric" value="${l.qtd || ""}" placeholder="0" />
        <input class="i-preco" type="number" min="0" step="0.01" inputmode="decimal" value="${l.precoUnit || ""}" placeholder="0,00" />
        <button type="button" class="nota-x" aria-label="Remover">✕</button>
      </div>
      <div class="nota-match">${badge}${l.skuAlvo ? ` <button type="button" class="conf-toggle">${l.criarNovo ? "casar com este" : "criar novo"}</button>` : ""}</div>`;
    const nomeInp = div.querySelector(".i-nome");
    nomeInp.addEventListener("input", (e) => { l.nome = e.target.value; });
    nomeInp.addEventListener("change", () => { rematchNota(l); renderNotaItens(); });
    div.querySelector(".i-qtd").addEventListener("input", (e) => { l.qtd = Number(e.target.value) || 0; });
    div.querySelector(".i-preco").addEventListener("input", (e) => { l.precoUnit = Number(e.target.value) || 0; });
    div.querySelector(".nota-x").addEventListener("click", () => { confNota.linhas.splice(idx, 1); if (!confNota.linhas.length) confNota.linhas.push(linhaNotaModelo({}, new Set())); renderNotaItens(); });
    const tg = div.querySelector(".conf-toggle");
    if (tg) tg.addEventListener("click", () => {
      l.criarNovo = !l.criarNovo;
      if (l.criarNovo && !l.skuNovo) l.skuNovo = gerarSku(l.nome || "item", new Set(confNota.linhas.map((x) => x.skuNovo).filter(Boolean)));
      renderNotaItens();
    });
    cont.appendChild(div);
  });
}

$("#btn-add-item-nota").addEventListener("click", () => { confNota.linhas.push(linhaNotaModelo({}, new Set())); renderNotaItens(); });

// Reavalia o aviso de duplicidade quando muda o nº da nota ou o fornecedor.
$("#form-nota").addEventListener("input", (e) => {
  if (e.target.name === "numero" || e.target.name === "fornecedor") verificarNotaDup();
});

$("#form-nota").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const fornecedor = f.fornecedor.value.trim();
  const data = f.data.value || hojeISO();
  const numero = f.numero ? f.numero.value.trim() : "";
  const notaChave = chaveNota(numero);
  const compras = [];
  confNota.linhas.forEach((l) => {
    if (l.nome && l.qtd > 0) {
      const sku = (l.criarNovo || !l.skuAlvo) ? l.skuNovo : l.skuAlvo;
      compras.push({ nome: l.nome, qtd: l.qtd, precoUnit: l.precoUnit, fornecedor, data, notaChave, sku, codigoBarras: l.codigoBarras || "" });
    }
  });
  if (compras.length === 0) { toast("Preencha ao menos um item (nome e quantidade)"); return; }
  // Trava de duplicidade: avisa e deixa decidir (não bloqueia).
  const dup = notaDuplicada(numero, fornecedor);
  if (dup && !confirm(`Você já lançou esta nota em ${dataBR(dup.data)}.\n\nSalvar de novo vai DUPLICAR o estoque (as quantidades somam de novo).\n\nTem certeza que quer lançar mesmo assim?`)) return;
  await comProgresso(async () => { for (const c of compras) await registrarCompra(c); });
  fechar("#modal-nota"); await recarregar(); irPara("estoque");
  toast(`${compras.length} ${compras.length === 1 ? "compra salva" : "compras salvas"} ✓`);
});

// ======================================================================
//  IMPORTAR PLANILHA DO SISTEMA (planograma / vendas) — .xlsx ou .csv
// ======================================================================
function opcoesPdv(sel) {
  return pdvsAtivos().map((p) => `<option value="${escaparAttr(p.nome)}" ${p.nome === sel ? "selected" : ""}>${escaparHtml(p.nome)}</option>`).join("");
}
function isoMenosDias(dias) { const d = new Date(); d.setDate(d.getDate() - dias); return d.toISOString().slice(0, 10); }
function isoMaisDias(iso, dias) {
  const p = String(iso).split("-").map(Number);
  const d = new Date(Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1));
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
// Períodos de vendas já importados numa adega (para evitar duplicidade).
function periodosImportados(pdv) {
  // Só os períodos que vieram de RELATÓRIO importado: venda avulsa é de um dia
  // só e não deve gerar alarme falso de "período sobreposto" na próxima
  // importação, nem empurrar a data sugerida.
  return periodosVendas(true).filter((p) => p.pdv === pdv)
    .map((p) => ({ inicio: p.inicio, fim: p.fim }))
    .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
}
// Sugere começar no dia seguinte ao último período já importado (evita sobreposição).
function proximoInicioSugerido(pdv) {
  const ps = periodosImportados(pdv);
  if (!ps.length) return isoMenosDias(30);
  const ultimoFim = ps.map((p) => p.fim).sort().slice(-1)[0];
  return ultimoFim ? isoMaisDias(ultimoFim, 1) : isoMenosDias(30);
}
function periodosSeSobrepoem(a, b) { return String(a.inicio) <= String(b.fim) && String(b.inicio) <= String(a.fim); }
function faixaSobreposta(a, b) { return { inicio: a.inicio > b.inicio ? a.inicio : b.inicio, fim: a.fim < b.fim ? a.fim : b.fim }; }
// Mapeia a categoria do sistema para o nosso "tipo" (Tinto/Branco/Rosé/Espumante).
function tipoDoRotulo(categoria) {
  const c = normTexto(categoria);
  if (/espum/.test(c)) return "Espumante";
  if (/branco/.test(c)) return "Branco";
  if (/rose|rosado/.test(c)) return "Rosé";
  return "Tinto";
}
// Gera um SKU único (considerando o estoque + os já reservados neste lote).
function gerarSku(nome, reservados) {
  const semAcento = (nome || "item").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const base = semAcento.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "item";
  let sku = base, i = 2;
  while (DADOS.estoque.some((x) => x.sku === sku) || reservados.has(sku)) sku = `${base}-${i++}`;
  reservados.add(sku);
  return sku;
}

// Um input só para os dois relatórios — o app detecta qual é.
$("#input-planilha").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  $("#carregando-msg").textContent = "Lendo a planilha…";
  abrir("#carregando");
  try {
    const r = await lerPlanilha(file);
    fechar("#carregando");
    if (r.tipo === "planograma") abrirConfPlanograma(r.itens);
    else if (r.tipo === "vendas") abrirConfVendas(r.itens);
    else toast("Não reconheci esse relatório. Use o planograma ou o de vendas por produto.");
  } catch (err) {
    fechar("#carregando"); console.error(err);
    toast("Não consegui ler o arquivo: " + (err.message || "tente outro"));
  }
});
[...$$(".btn-importar")].forEach((b) => b.addEventListener("click", () => $("#input-planilha").click()));

// ---- Conferência do PLANOGRAMA (posição atual da adega) ----
let confPlano = null;
function abrirConfPlanograma(itens) {
  const reservados = new Set();
  const linhas = itens.map((it) => {
    const m = casarRotulo(it);
    return {
      ...it,
      incluir: true,
      criarNovo: !m.item,
      skuAlvo: m.item ? m.item.sku : "",
      nomeAlvo: m.item ? m.item.nome : "",
      forte: m.forte,
      skuNovo: m.item ? "" : gerarSku(it.nome, reservados),
    };
  });
  confPlano = { pdv: pdvAtual, linhas };
  $("#conf-plano-pdv").innerHTML = opcoesPdv(pdvAtual);
  renderConfPlano();
  abrir("#modal-conf-plano");
}
function renderConfPlano() {
  const linhas = confPlano.linhas;
  const inc = linhas.filter((l) => l.incluir);
  const novos = inc.filter((l) => l.criarNovo || !l.skuAlvo).length;
  const atualiza = inc.length - novos;
  $("#conf-plano-resumo").innerHTML = `<b>${inc.length}</b> de ${linhas.length} produtos · ${atualiza} atualizam a adega · ${novos} rótulos novos`;
  const cont = $("#conf-plano-lista");
  cont.innerHTML = "";
  linhas.forEach((l, idx) => {
    const casou = !l.criarNovo && l.skuAlvo;
    const badge = casou
      ? `<span class="conf-badge ${l.forte ? "ok" : "fraco"}">→ ${escaparHtml(l.nomeAlvo)}${l.forte ? "" : " ?"}</span>`
      : `<span class="conf-badge novo">＋ novo rótulo</span>`;
    const div = el("div", "conf-linha" + (l.incluir ? "" : " off"));
    div.innerHTML = `
      <label class="conf-ck"><input type="checkbox" ${l.incluir ? "checked" : ""} data-i="${idx}" /></label>
      <div class="conf-corpo">
        <div class="conf-nome">${escaparHtml(l.nome)} <small class="conf-cat">${escaparHtml(l.categoria || "")}</small></div>
        <div class="conf-sub">${badge}
          ${l.skuAlvo ? `<button type="button" class="conf-toggle" data-t="${idx}">${l.criarNovo ? "casar" : "criar novo"}</button>` : ""}
        </div>
      </div>
      <div class="conf-qtd"><small>adega</small><input type="number" min="0" step="1" value="${l.quantAtual}" data-q="${idx}" /></div>`;
    cont.appendChild(div);
  });
  cont.querySelectorAll("input[data-i]").forEach((c) => c.addEventListener("change", (e) => {
    confPlano.linhas[+e.target.dataset.i].incluir = e.target.checked; renderConfPlano();
  }));
  cont.querySelectorAll("input[data-q]").forEach((c) => c.addEventListener("input", (e) => {
    confPlano.linhas[+e.target.dataset.q].quantAtual = Number(e.target.value) || 0;
  }));
  cont.querySelectorAll("button[data-t]").forEach((b) => b.addEventListener("click", (e) => {
    const l = confPlano.linhas[+e.target.dataset.t];
    l.criarNovo = !l.criarNovo;
    if (l.criarNovo && !l.skuNovo) l.skuNovo = gerarSku(l.nome, new Set(confPlano.linhas.map((x) => x.skuNovo).filter(Boolean)));
    renderConfPlano();
  }));
}
$("#conf-plano-pdv").addEventListener("change", (e) => { if (confPlano) confPlano.pdv = e.target.value; });
$("#btn-conf-plano-salvar").addEventListener("click", async () => {
  const pdv = $("#conf-plano-pdv").value || pdvAtual;
  const resolvidos = confPlano.linhas.filter((l) => l.incluir).map((l) => ({
    sku: l.criarNovo || !l.skuAlvo ? l.skuNovo : l.skuAlvo,
    novo: l.criarNovo || !l.skuAlvo,
    rotulo: { nome: l.nome, codigo: l.codigo, codigoBarras: l.codigoBarras, categoria: l.categoria, tipo: tipoDoRotulo(l.categoria), precoVenda: l.precoVenda },
    quantAtual: l.quantAtual, minimo: l.minimo, nivelPar: l.nivelPar,
  }));
  if (!resolvidos.length) { toast("Marque ao menos um produto"); return; }
  await comProgresso(() => aplicarImportPlanograma(pdv, resolvidos));
  fechar("#modal-conf-plano"); pdvAtual = pdv; await recarregarDoServidor(); irPara("estoque");
  toast(`Planograma importado ✓ (${resolvidos.length} produtos)`);
});

// ---- Conferência das VENDAS (giro do período) ----
let confVendas = null;
function abrirConfVendas(itens) {
  const reservados = new Set();
  const linhas = itens.map((it) => {
    const m = casarRotulo(it);
    return {
      ...it, incluir: true,
      criarNovo: !m.item, skuAlvo: m.item ? m.item.sku : "", nomeAlvo: m.item ? m.item.nome : "",
      forte: m.forte, skuNovo: m.item ? "" : gerarSku(it.nome, reservados),
    };
  });
  confVendas = { pdv: pdvAtual, linhas };
  $("#conf-vendas-pdv").innerHTML = opcoesPdv(pdvAtual);
  $("#conf-vendas-inicio").value = proximoInicioSugerido(pdvAtual);
  $("#conf-vendas-fim").value = hojeISO();
  atualizarPeriodoLabel();
  atualizarJaImportados(pdvAtual);
  renderConfVendas();
  abrir("#modal-conf-vendas");
}
// Legenda do período em pt-BR (o seletor nativo pode mostrar em formato americano).
function atualizarPeriodoLabel() {
  const i = $("#conf-vendas-inicio").value, f = $("#conf-vendas-fim").value;
  $("#conf-vendas-periodo").innerHTML = (i && f) ? `📅 Período: <b>${dataBR(i)}</b> até <b>${dataBR(f)}</b>` : "";
}
// Mostra os períodos já importados na adega e sinaliza sobreposição com o atual.
function atualizarJaImportados(pdv) {
  const cont = $("#conf-vendas-jaimport"); if (!cont) return;
  const ps = periodosImportados(pdv);
  if (!ps.length) { cont.innerHTML = "Nenhuma venda importada nesta adega ainda."; cont.className = "conf-jaimport"; return; }
  const atual = { inicio: $("#conf-vendas-inicio").value, fim: $("#conf-vendas-fim").value };
  const temSobrep = atual.inicio && atual.fim && ps.some((p) => periodosSeSobrepoem(p, atual));
  const lista = ps.map((p) => `${dataBR(p.inicio)}–${dataBR(p.fim)}`).join(" · ");
  cont.innerHTML = `Já importados nesta adega: ${lista}` + (temSobrep ? `<br><b>⚠ o período atual se sobrepõe a um destes.</b>` : "");
  cont.className = "conf-jaimport" + (temSobrep ? " alerta" : "");
}
["#conf-vendas-inicio", "#conf-vendas-fim"].forEach((s) => $(s).addEventListener("change", () => {
  atualizarPeriodoLabel();
  atualizarJaImportados($("#conf-vendas-pdv").value || pdvAtual);
}));
function estaNaAdega(sku, pdv) { return !!linhaPdv(sku, pdv); }
// Os rótulos mais PARECIDOS com o nome da venda, com o % de semelhança.
// Prioriza quem está na adega no desempate (é onde a garrafa deveria estar).
const REL_SUG_MIN = 0.2;  // abaixo disso não é sugestão, é chute
function sugestoesRotulo(nomeVenda, pdv, limite = 5) {
  return (DADOS.estoque || [])
    .map((it) => ({ it, s: semelhancaRotulo(nomeVenda, it.nome), naAdega: estaNaAdega(it.sku, pdv) }))
    .filter((c) => c.s >= REL_SUG_MIN)
    .sort((a, b) => (b.s - a.s) || (Number(b.naAdega) - Number(a.naAdega)) || String(a.it.nome).localeCompare(String(b.it.nome)))
    .slice(0, limite);
}
// Opções de rótulo para relacionar uma venda: as SUGESTÕES (com % de semelhança)
// no topo, depois os da adega e os outros em ordem alfabética — assim quem já
// sabe o nome continua achando pela lista, e quem não sabe começa pelo palpite.
function opcoesRotuloVendas(l, pdv) {
  const naAdega = [], outros = [];
  (DADOS.estoque || []).slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome))).forEach((it) => {
    const emAdega = estaNaAdega(it.sku, pdv);
    const sel = (!l.criarNovo && l.skuAlvo === it.sku) ? "selected" : "";
    const rot = escaparHtml(it.nome || it.sku) + (emAdega ? ` (adega: ${qtdNoPdv(it.sku, pdv)})` : "");
    const opt = `<option value="${escaparAttr(it.sku)}" ${sel}>${rot}</option>`;
    (emAdega ? naAdega : outros).push(opt);
  });
  let html = "";
  const sug = sugestoesRotulo(l.nome, pdv);
  if (sug.length) {
    html += `<optgroup label="Sugestões (parecidos com o nome da venda)">` + sug.map((c) => {
      const sel = (!l.criarNovo && l.skuAlvo === c.it.sku) ? "selected" : "";
      const rot = `${escaparHtml(c.it.nome || c.it.sku)} — ${Math.round(c.s * 100)}%` +
        (c.naAdega ? ` (adega: ${qtdNoPdv(c.it.sku, pdv)})` : " (fora desta adega)");
      return `<option value="${escaparAttr(c.it.sku)}" ${sel}>${rot}</option>`;
    }).join("") + `</optgroup>`;
  }
  if (naAdega.length) html += `<optgroup label="Nesta adega">${naAdega.join("")}</optgroup>`;
  if (outros.length) html += `<optgroup label="Outros rótulos (não estão nesta adega)">${outros.join("")}</optgroup>`;
  html += `<option value="__novo__" ${l.criarNovo ? "selected" : ""}>＋ Criar rótulo novo</option>`;
  return html;
}
function renderConfVendas() {
  const linhas = confVendas.linhas;
  const inc = linhas.filter((l) => l.incluir);
  const totUn = inc.reduce((s, l) => s + (Number(l.qtd) || 0), 0);
  const totRs = inc.reduce((s, l) => s + (Number(l.valorVendido) || 0), 0);
  const pdv = $("#conf-vendas-pdv").value || confVendas.pdv;
  // Uma venda "precisa de atenção" em 3 casos: (a) não achou rótulo nenhum,
  // (b) achou um que NÃO consta nesta adega, ou (c) casou só por semelhança de
  // nome (match fraco) — esse último é o mais perigoso, porque pode ser o vinho
  // errado, e antes passava sem aviso quando o rótulo estava na adega.
  const fraco = (l) => !l.criarNovo && l.skuAlvo && !l.forte && !l.manual;
  const precisa = (l) => l.incluir && (l.criarNovo || !l.skuAlvo || !estaNaAdega(l.skuAlvo, pdv) || fraco(l));
  const nAviso = inc.filter(precisa).length;
  $("#conf-vendas-resumo").innerHTML = `<b>${inc.length}</b> rótulos · ${totUn} garrafas vendidas · ${brl(totRs)}`
    + (nAviso ? `<div class="conf-aviso-topo">⚠ ${nAviso} ${nAviso === 1 ? "venda precisa" : "vendas precisam"} de conferência. Confirme o rótulo abaixo (as sugestões vêm com o % de semelhança), ou confirme criar rótulo novo.</div>` : "");
  const cont = $("#conf-vendas-lista");
  cont.innerHTML = "";
  linhas.forEach((l, idx) => {
    const casou = !l.criarNovo && l.skuAlvo;
    const naAdega = casou ? qtdNoPdv(l.skuAlvo, pdv) : 0;
    const ficará = Math.max(0, naAdega - (Number(l.qtd) || 0));
    const forte = l.forte || l.manual;
    const sem = casou ? Math.round(semelhancaRotulo(l.nome, l.nomeAlvo) * 100) : 0;
    const badge = casou
      ? `<span class="conf-badge ${forte ? "ok" : "fraco"}">→ ${escaparHtml(l.nomeAlvo)}${forte ? "" : ` ? ${sem}%`}</span>`
      : `<span class="conf-badge novo">＋ novo rótulo</span>`;
    const descHtml = casou && estaNaAdega(l.skuAlvo, pdv) ? `<span class="conf-desc">adega ${naAdega} → <b>${ficará}</b></span>` : "";
    const motivo = (l.criarNovo || !l.skuAlvo) ? "não bate com nenhum rótulo desta adega"
      : fraco(l) ? `casou só por semelhança de nome (${sem}%) — confira se é mesmo este vinho`
      : "esse rótulo não consta nesta adega";
    const aviso = precisa(l) ? `<div class="conf-aviso">⚠ ${motivo} — relacione:</div>` : "";
    const div = el("div", "conf-linha" + (l.incluir ? "" : " off") + (precisa(l) ? " atencao" : ""));
    div.innerHTML = `
      <label class="conf-ck"><input type="checkbox" ${l.incluir ? "checked" : ""} data-i="${idx}" /></label>
      <div class="conf-corpo">
        <div class="conf-nome">${escaparHtml(l.nome)} <small class="conf-cat">${Number(l.qtd) || 0} un. · ${brl(l.valorVendido)}</small></div>
        <div class="conf-sub">${badge}${descHtml}</div>
        ${aviso}
        <select class="conf-rotulo" data-r="${idx}" aria-label="Relacionar venda a um rótulo">${opcoesRotuloVendas(l, pdv)}</select>
      </div>`;
    cont.appendChild(div);
  });
  cont.querySelectorAll("input[data-i]").forEach((c) => c.addEventListener("change", (e) => {
    confVendas.linhas[+e.target.dataset.i].incluir = e.target.checked; renderConfVendas();
  }));
  cont.querySelectorAll("select[data-r]").forEach((s) => s.addEventListener("change", (e) => {
    const l = confVendas.linhas[+e.target.dataset.r];
    const val = e.target.value;
    if (val === "__novo__") {
      l.criarNovo = true; l.skuAlvo = ""; l.nomeAlvo = ""; l.manual = false;
      if (!l.skuNovo) l.skuNovo = gerarSku(l.nome, new Set(confVendas.linhas.map((x) => x.skuNovo).filter(Boolean)));
    } else {
      const it = DADOS.estoque.find((x) => x.sku === val);
      l.criarNovo = false; l.skuAlvo = val; l.nomeAlvo = it ? it.nome : ""; l.manual = true;
    }
    renderConfVendas();
  }));
}
$("#conf-vendas-pdv").addEventListener("change", (e) => {
  if (!confVendas) return;
  confVendas.pdv = e.target.value;
  $("#conf-vendas-inicio").value = proximoInicioSugerido(e.target.value);
  atualizarPeriodoLabel();
  atualizarJaImportados(e.target.value);
  renderConfVendas();
});
$("#btn-conf-vendas-salvar").addEventListener("click", async () => {
  const pdv = $("#conf-vendas-pdv").value || pdvAtual;
  const periodo = { inicio: $("#conf-vendas-inicio").value || isoMenosDias(30), fim: $("#conf-vendas-fim").value || hojeISO() };
  if (periodo.inicio > periodo.fim) { toast("A data inicial está depois da final — confira o período"); return; }
  const resolvidos = confVendas.linhas.filter((l) => l.incluir).map((l) => ({
    sku: l.criarNovo || !l.skuAlvo ? l.skuNovo : l.skuAlvo,
    novo: l.criarNovo || !l.skuAlvo,
    rotulo: { nome: l.nome, codigo: l.codigo, categoria: l.categoria, tipo: tipoDoRotulo(l.categoria), precoVenda: l.precoMedio },
    codigo: l.codigo, categoria: l.categoria,
    qtd: l.qtd, precoMedio: l.precoMedio, valorVendido: l.valorVendido,
  }));
  if (!resolvidos.length) { toast("Marque ao menos um rótulo"); return; }

  // --- Guarda de duplicidade (por período) ---
  const existentes = periodosImportados(pdv);
  const exato = existentes.find((p) => p.inicio === periodo.inicio && p.fim === periodo.fim);
  const sobrepostos = existentes.filter((p) => !(p.inicio === periodo.inicio && p.fim === periodo.fim) && periodosSeSobrepoem(p, periodo));
  if (exato) {
    if (!confirm(`Você já importou vendas exatamente deste período (${dataBR(periodo.inicio)}–${dataBR(periodo.fim)}).\n\nVou SUBSTITUIR: as garrafas da importação antiga voltam para a adega e as novas são aplicadas (não duplica).\n\nContinuar?`)) return;
  } else if (sobrepostos.length) {
    const faixas = sobrepostos.map((p) => { const f = faixaSobreposta(p, periodo); return `• ${dataBR(f.inicio)}–${dataBR(f.fim)}`; }).join("\n");
    if (!confirm(`⚠ ATENÇÃO — sobreposição de período!\n\nEste período pega dias que você já importou:\n${faixas}\n\nAs vendas desses dias serão contadas EM DOBRO (descontam da adega duas vezes).\n\nTem certeza que quer importar assim mesmo?`)) return;
  }
  await comProgresso(async () => {
    if (exato) await excluirVendasPeriodo(pdv, exato.inicio, exato.fim); // substitui: remove o antigo e devolve à adega
    await aplicarImportVendas(periodo, pdv, resolvidos);
  });
  fechar("#modal-conf-vendas"); pdvAtual = pdv; await recarregarDoServidor(); irPara("giro");
  toast(exato ? `Período substituído ✓ (${resolvidos.length} rótulos)` : `Vendas importadas ✓ (${resolvidos.length} rótulos)`);
});

// ======================================================================
//  MODAL — ABASTECER ADEGA (retaguarda → PDV)
// ======================================================================
function abrirModalAbastecer(item) {
  const f = $("#form-abastecer");
  f.reset();
  f.sku.value = item.sku;
  $("#abastecer-nome").textContent = item.nome || "(sem nome)";
  $("#abastecer-pdv").innerHTML = opcoesPdv(pdvAtual);
  const retag = Number(item.qtd) || 0;
  f.qtd.max = retag;
  f.qtd.value = Math.min(retag, Number(item.__nivelSugerido) || retag) || retag;
  $("#abastecer-disp").textContent = `Retaguarda disponível: ${retag}`;
  abrir("#modal-abastecer");
}
$("#form-abastecer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const sku = f.sku.value, pdv = f.pdv.value || pdvAtual, qtd = Number(f.qtd.value) || 0;
  const item = DADOS.estoque.find((x) => x.sku === sku);
  const retag = item ? (Number(item.qtd) || 0) : 0;
  if (qtd <= 0) { toast("Informe quantas garrafas"); return; }
  if (qtd > retag) { toast("Você não tem tudo isso na retaguarda"); return; }
  await comProgresso(() => abastecerPdv(sku, pdv, qtd));
  fechar("#modal-abastecer"); pdvAtual = pdv; await recarregar();
  toast(`${qtd} ${qtd === 1 ? "garrafa" : "garrafas"} na adega ✓`);
});

// --- Modal: Mover garrafas (entre adegas / devolver à retaguarda) ---
function abrirModalMover(item) {
  const f = $("#form-mover"); f.reset();
  f.sku.value = item.sku;
  $("#mover-nome").textContent = item.nome || "(sem nome)";
  $("#mover-origem").textContent = pdvAtual;
  const disp = qtdNoPdv(item.sku, pdvAtual);
  const outras = pdvsAtivos().filter((p) => p.nome !== pdvAtual);
  let opts = outras.map((p) => `<option value="pdv:${escaparAttr(p.nome)}">🏬 ${escaparHtml(p.nome)}</option>`).join("");
  opts += `<option value="retag">↩ Retaguarda (estoque guardado)</option>`;
  $("#mover-destino").innerHTML = opts;
  f.qtd.max = disp; f.qtd.value = disp > 0 ? 1 : 0;
  $("#mover-disp").textContent = `Disponível na adega ${pdvAtual}: ${disp}`;
  abrir("#modal-mover");
}
$("#form-mover").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const sku = f.sku.value, destino = f.destino.value, qtd = Number(f.qtd.value) || 0;
  const disp = qtdNoPdv(sku, pdvAtual);
  if (qtd <= 0) { toast("Informe quantas garrafas"); return; }
  if (qtd > disp) { toast("A adega não tem tudo isso"); return; }
  if (destino === "retag") {
    await comProgresso(() => devolverParaRetaguarda(sku, pdvAtual, qtd));
    fechar("#modal-mover"); await recarregar();
    toast(`${qtd} ${qtd === 1 ? "garrafa devolvida" : "garrafas devolvidas"} à retaguarda ✓`);
  } else if (destino.indexOf("pdv:") === 0) {
    const dest = destino.slice(4);
    await comProgresso(() => transferirEntreAdegas(sku, pdvAtual, dest, qtd));
    fechar("#modal-mover"); await recarregar();
    toast(`${qtd} ${qtd === 1 ? "garrafa movida" : "garrafas movidas"} para ${dest} ✓`);
  }
});

// ======================================================================
//  RENDER — GIRO (o que saiu, por período importado)
// ======================================================================
// Venda lançada à mão (pix, encomenda) em vez de vinda do relatório da adega.
function vendaAvulsa(v) { return String((v && v.origem) || "").indexOf("avulsa") === 0; }
function periodosVendas(soImportadas) {
  // Agrupa por (pdv|inicio|fim); devolve as chaves ordenadas do mais recente ao mais antigo.
  const mapa = {};
  (DADOS.vendas || []).filter((v) => !soImportadas || !vendaAvulsa(v)).forEach((v) => {
    const k = `${v.pdv}||${v.periodoInicio}||${v.periodoFim}`;
    (mapa[k] = mapa[k] || []).push(v);
  });
  return Object.keys(mapa).map((k) => {
    const [pdv, inicio, fim] = k.split("||");
    return { chave: k, pdv, inicio, fim, linhas: mapa[k] };
  }).sort((a, b) => String(b.fim).localeCompare(String(a.fim)));
}
// --- PAINEL FINANCEIRO (aba "Financeiro"; internamente ainda data-aba="giro") ---
function finRange() {
  return { de: $("#fin-de") ? $("#fin-de").value : "", ate: $("#fin-ate") ? $("#fin-ate").value : "", pdv: ($("#fin-pdv") && $("#fin-pdv").value) || "__todas__" };
}
function vendasNoRange(de, ate, pdv) {
  return (DADOS.vendas || []).filter((v) => {
    if (pdv !== "__todas__" && v.pdv !== pdv) return false;
    return (!de || String(v.periodoFim) >= de) && (!ate || String(v.periodoInicio) <= ate); // período sobrepõe a faixa
  });
}
function despesasNoRange(de, ate, pdv) {
  return (DADOS.despesas || []).filter((d) => {
    if (pdv !== "__todas__" && d.pdv !== pdv) return false;
    return (!de || String(d.data) >= de) && (!ate || String(d.data) <= ate);
  });
}
function renderGiro() {
  // Seletor de adega (Todas + ativas), preservando a escolha.
  const selP = $("#fin-pdv");
  if (selP) {
    const prev = selP.value;
    selP.innerHTML = `<option value="__todas__">Todas as adegas</option>` +
      pdvsAtivos().map((p) => `<option value="${escaparAttr(p.nome)}">${escaparHtml(p.nome)}</option>`).join("");
    selP.value = (prev && [...selP.options].some((o) => o.value === prev)) ? prev : "__todas__";
  }
  // Datas padrão na 1ª vez: abrange todas as vendas (ou últimos 30 dias).
  const vTodas = DADOS.vendas || [];
  if ($("#fin-de") && !$("#fin-de").value) {
    const ini = vTodas.map((v) => v.periodoInicio).filter(Boolean).sort();
    $("#fin-de").value = ini[0] || isoMenosDias(30);
  }
  if ($("#fin-ate") && !$("#fin-ate").value) {
    const fim = vTodas.map((v) => v.periodoFim).filter(Boolean).sort();
    $("#fin-ate").value = fim[fim.length - 1] || hojeISO();
  }
  const { de, ate, pdv } = finRange();
  const vendas = vendasNoRange(de, ate, pdv);
  const desp = despesasNoRange(de, ate, pdv);

  // DRE: Faturamento − Custo dos produtos = Lucro bruto − Despesas = Lucro líquido.
  const faturamento = vendas.reduce((s, v) => s + (Number(v.valorVendido) || 0), 0);
  let cmv = 0;
  vendas.forEach((v) => {
    const it = DADOS.estoque.find((x) => x.sku === v.sku);
    const custo = it ? (Number(it.precoAquisicao) || 0) : 0;
    cmv += custo * (Number(v.qtd) || 0);
  });
  const lucroBruto = faturamento - cmv;
  const totDesp = desp.reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const lucroLiquido = lucroBruto - totDesp;
  const linhaDre = (rot, val, cls) => `<div class="dre-linha ${cls || ""}"><span>${rot}</span><b>${brl(val)}</b></div>`;
  $("#fin-dre").innerHTML =
    linhaDre("Faturamento", faturamento) +
    linhaDre("− Custo dos produtos", cmv) +
    linhaDre("= Lucro bruto", lucroBruto, "dre-sub") +
    linhaDre("− Despesas", totDesp) +
    `<div class="dre-linha dre-total ${lucroLiquido >= 0 ? "lucro" : "prejuizo"}"><span>= Lucro líquido</span><b>${brl(lucroLiquido)}</b></div>`;

  // Vendas avulsas do período (lançadas à mão, fora do sistema da adega).
  const ca = $("#fin-avulsas");
  if (ca) {
    const avulsas = vendas.filter(vendaAvulsa);
    ca.innerHTML = "";
    if (!avulsas.length) {
      ca.innerHTML = `<p class="dica">Nenhuma venda avulsa neste período. Use <b>＋ Venda avulsa</b> para lançar o que não passou pela maquininha (pix, encomenda).</p>`;
    } else {
      avulsas.slice().sort((a, b) => String(b.periodoInicio).localeCompare(String(a.periodoInicio))).forEach((v) => {
        const it = DADOS.estoque.find((x) => x.sku === v.sku);
        const daRet = v.origem === "avulsa-retaguarda";
        const row = el("div", "despesa-row");
        row.innerHTML = `
          <div class="despesa-info">
            <span class="despesa-cat">${escaparHtml((it && it.nome) || v.descricao || v.sku)}</span>
            <span class="despesa-sub">${dataBR(v.periodoInicio)} · ${escaparHtml(v.pdv)} · ${Number(v.qtd) || 0} un. × ${brl(v.precoMedio)} · ${daRet ? "da retaguarda" : "da adega"}</span>
          </div>
          <span class="despesa-val">${brl(v.valorVendido)}</span>
          <button class="despesa-x" aria-label="Excluir venda avulsa" title="Excluir venda avulsa">✕</button>`;
        row.querySelector(".despesa-x").addEventListener("click", async () => {
          if (!confirm(`Excluir esta venda avulsa de ${Number(v.qtd) || 0} un. (${brl(v.valorVendido)})?\n\nAs garrafas voltam para ${daRet ? "a retaguarda" : "a adega " + v.pdv}.`)) return;
          await comProgresso(() => excluirVenda(v)); renderGiro(); toast("Venda avulsa excluída");
        });
        ca.appendChild(row);
      });
    }
  }

  // Despesas do período.
  const cd = $("#fin-despesas");
  cd.innerHTML = "";
  if (!desp.length) {
    cd.innerHTML = `<p class="dica">Nenhuma despesa neste período. Toque em ＋ Despesa.</p>`;
  } else {
    desp.slice().sort((a, b) => String(b.data).localeCompare(String(a.data))).forEach((d) => {
      const row = el("div", "despesa-row");
      row.innerHTML = `
        <div class="despesa-info">
          <span class="despesa-cat">${escaparHtml(d.categoria || "Despesa")}</span>
          <span class="despesa-sub">${dataBR(d.data)}${d.pdv ? " · " + escaparHtml(d.pdv) : " · geral"}${d.descricao ? " · " + escaparHtml(d.descricao) : ""}</span>
        </div>
        <span class="despesa-val">${brl(d.valor)}</span>
        <button class="despesa-x" aria-label="Excluir despesa" title="Excluir despesa">✕</button>`;
      row.querySelector(".despesa-x").addEventListener("click", async () => {
        if (!confirm(`Excluir a despesa "${d.categoria || ""}" de ${brl(d.valor)}?`)) return;
        await comProgresso(() => excluirDespesa(d)); renderGiro(); toast("Despesa excluída");
      });
      cd.appendChild(row);
    });
  }

  // Ranking de vendas (o que girou) no período.
  const porSku = {};
  vendas.forEach((v) => {
    const k = v.sku || v.descricao;
    const a = porSku[k] || (porSku[k] = { sku: v.sku, descricao: v.descricao, qtd: 0, valor: 0 });
    a.qtd += Number(v.qtd) || 0; a.valor += Number(v.valorVendido) || 0;
  });
  const cont = $("#giro-lista");
  cont.innerHTML = "";
  $("#vazio-giro").classList.toggle("hidden", vendas.length > 0 || desp.length > 0);
  Object.values(porSku).sort((a, b) => b.qtd - a.qtd).forEach((a) => {
    const it = DADOS.estoque.find((x) => x.sku === a.sku);
    const precoMedio = a.qtd ? a.valor / a.qtd : 0;
    const custo = it ? (Number(it.precoAquisicao) || 0) : 0;
    const margem = custo > 0 ? precoMedio - custo : null;
    const card = el("div", "giro-item");
    card.innerHTML = `
      <div class="giro-info">
        <div class="giro-nome">${escaparHtml(it ? it.nome : a.descricao)}</div>
        <div class="giro-meta">
          <span>Faturou: <b>${brl(a.valor)}</b></span>
          ${margem != null ? `<span class="${margem >= 0 ? "lucro" : "prejuizo"}">Margem/un: <b>${brl(margem)}</b></span>` : ""}
        </div>
      </div>
      <div class="giro-qtd"><span class="giro-num">${a.qtd}</span><small>vendidas</small></div>`;
    cont.appendChild(card);
  });
}
["#fin-pdv", "#fin-de", "#fin-ate"].forEach((s) => { const el0 = $(s); if (el0) el0.addEventListener("change", renderGiro); });

// ======================================================================
//  ABA RELATÓRIOS — análises de vendas com gráficos
//  Sem biblioteca externa: todo gráfico é uma BARRA HORIZONTAL em CSS.
//  Regras de leitura adotadas:
//   · o valor está sempre ESCRITO ao lado do rótulo (a barra só dá a
//     leitura rápida) — nenhuma informação depende de cor ou de passar
//     o mouse, o que também resolve o uso no celular;
//   · uma série = uma cor (dourado). Verde/vermelho só significam
//     lucro/prejuízo, nunca "categoria";
//   · um único conjunto de filtros (adega + período) no topo vale para
//     TODOS os blocos abaixo.
// ======================================================================
let relOrdemGiro = "qtd";      // qtd | valor
let relOrdemMargem = "lucro";  // lucro | unidade | percentual
const REL_TOPO = 10;           // quantos rótulos cada ranking mostra

function relRange() {
  return { de: $("#rel-de") ? $("#rel-de").value : "", ate: $("#rel-ate") ? $("#rel-ate").value : "", pdv: ($("#rel-pdv") && $("#rel-pdv").value) || "__todas__" };
}
const relPct = (n) => (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + "%";

// Agrega as vendas do período por rótulo e calcula custo/lucro quando o
// rótulo tem preço de aquisição cadastrado (sem custo → fica fora do lucro).
function relAgregarPorSku(vendas) {
  const mapa = {};
  vendas.forEach((v) => {
    const k = v.sku || "desc:" + normTexto(v.descricao);
    const a = mapa[k] || (mapa[k] = { sku: v.sku, descricao: v.descricao, categoria: v.categoria, qtd: 0, valor: 0 });
    a.qtd += Number(v.qtd) || 0;
    a.valor += Number(v.valorVendido) || 0;
    if (!a.categoria && v.categoria) a.categoria = v.categoria;
  });
  return Object.values(mapa).map((a) => {
    const it = a.sku ? DADOS.estoque.find((x) => x.sku === a.sku) : null;
    const custo = it ? Number(it.precoAquisicao) || 0 : 0;
    const precoMedio = a.qtd ? a.valor / a.qtd : 0;
    const temCusto = custo > 0;
    return Object.assign(a, {
      nome: (it && it.nome) || a.descricao || "(sem nome)",
      tipo: (it && it.tipo) || tipoDoRotulo(a.categoria),
      custo, precoMedio, temCusto,
      cmv: temCusto ? custo * a.qtd : 0,
      margemUn: temCusto ? precoMedio - custo : null,
      lucro: temCusto ? (precoMedio - custo) * a.qtd : null,
      // Margem sobre a venda: quanto de cada real vendido sobrou antes das despesas.
      margemPct: temCusto && precoMedio > 0 ? ((precoMedio - custo) / precoMedio) * 100 : null,
    });
  });
}

// --- Peças visuais -----------------------------------------------------
// `rotulo`/`extra` chegam como HTML já escapado por quem chama.
function relBarra(rotulo, valorTexto, valor, maximo, extra, cls) {
  const pct = maximo > 0 ? Math.max(0, Math.min(100, (Number(valor) || 0) / maximo * 100)) : 0;
  return `<div class="rel-barra">
      <div class="rel-barra-topo"><span class="rel-barra-rot">${rotulo}</span><b class="rel-barra-val ${cls || ""}">${valorTexto}</b></div>
      <div class="rel-barra-trilha"><span class="rel-barra-fill" style="width:${pct.toFixed(1)}%"></span></div>
      ${extra ? `<div class="rel-barra-extra">${extra}</div>` : ""}
    </div>`;
}
function relSecao(titulo, corpo, chips, dica) {
  if (!corpo) return "";
  return `<section class="rel-secao">
      <div class="rel-secao-topo"><h3>${titulo}</h3>${chips || ""}</div>
      ${dica ? `<p class="dica rel-dica">${dica}</p>` : ""}
      ${corpo}
    </section>`;
}
function relChips(grupo, opcoes, atual) {
  return `<div class="filtros rel-chips">` + opcoes.map((o) =>
    `<button type="button" class="chip ${o.v === atual ? "ativo" : ""}" data-rel-grupo="${grupo}" data-rel-valor="${escaparAttr(o.v)}">${escaparHtml(o.rot)}</button>`).join("") + `</div>`;
}
function relKpi(rot, val, cls) {
  return `<div class="rel-kpi"><span class="rel-kpi-rot">${escaparHtml(rot)}</span><b class="rel-kpi-num ${cls || ""}">${val}</b></div>`;
}

// --- Blocos ------------------------------------------------------------
function relResumo(ag) {
  const qtd = ag.reduce((s, a) => s + a.qtd, 0);
  const fat = ag.reduce((s, a) => s + a.valor, 0);
  const comCusto = ag.filter((a) => a.temCusto);
  const cmv = comCusto.reduce((s, a) => s + a.cmv, 0);
  const fatComCusto = comCusto.reduce((s, a) => s + a.valor, 0);
  const lucro = fatComCusto - cmv;
  const margem = fatComCusto > 0 ? lucro / fatComCusto * 100 : null;
  const semCusto = ag.length - comCusto.length;
  return `<section class="rel-secao">
      <div class="rel-hero">
        <span class="rel-hero-rot">Faturamento no período</span>
        <strong class="rel-hero-num">${brl(fat)}</strong>
      </div>
      <div class="rel-kpis">
        ${relKpi("Garrafas vendidas", qtd)}
        ${relKpi("Lucro bruto", brl(lucro), lucro >= 0 ? "lucro" : "prejuizo")}
        ${relKpi("Margem média", margem == null ? "—" : relPct(margem))}
        ${relKpi("Média por garrafa", brl(qtd ? fat / qtd : 0))}
      </div>
      ${semCusto ? `<p class="dica rel-dica">⚠ ${semCusto} rótulo${semCusto > 1 ? "s" : ""} sem <b>preço de aquisição</b> cadastrado ${semCusto > 1 ? "ficam" : "fica"} fora do lucro e da margem. Cadastre o custo no Estoque para a conta fechar.</p>` : ""}
    </section>`;
}

function relPorTipo(ag) {
  const tipos = {};
  ag.forEach((a) => {
    const t = tipos[a.tipo] || (tipos[a.tipo] = { tipo: a.tipo, qtd: 0, valor: 0 });
    t.qtd += a.qtd; t.valor += a.valor;
  });
  const lista = Object.values(tipos).sort((a, b) => b.qtd - a.qtd);
  if (lista.length < 2) return ""; // uma categoria só não é gráfico
  const fatTotal = lista.reduce((s, t) => s + t.valor, 0);
  const maxQtd = Math.max.apply(null, lista.map((t) => t.qtd));
  const corpo = lista.map((t) => relBarra(
    `<span class="tag-tipo ${classeTipo(t.tipo)}">${escaparHtml(t.tipo)}</span>`,
    `${t.qtd} garrafa${t.qtd === 1 ? "" : "s"}`, t.qtd, maxQtd,
    `Faturou ${escaparHtml(brl(t.valor))} · ${escaparHtml(relPct(fatTotal > 0 ? t.valor / fatTotal * 100 : 0))} do faturamento`)).join("");
  return relSecao("Vendas por tipo", corpo, "", "Quantas garrafas de cada tipo saíram no período.");
}

function relGiro(ag) {
  if (!ag.length) return "";
  const porValor = relOrdemGiro === "valor";
  const lista = ag.slice().sort((a, b) => (porValor ? b.valor - a.valor : b.qtd - a.qtd)).slice(0, REL_TOPO);
  const max = Math.max.apply(null, lista.map((a) => (porValor ? a.valor : a.qtd)));
  const corpo = lista.map((a, i) => relBarra(
    `<span class="rel-pos">${i + 1}º</span> ${escaparHtml(a.nome)}`,
    porValor ? brl(a.valor) : `${a.qtd} un.`,
    porValor ? a.valor : a.qtd, max,
    porValor ? `${a.qtd} garrafa${a.qtd === 1 ? "" : "s"} · ${escaparHtml(brl(a.precoMedio))} por garrafa`
             : `Faturou ${escaparHtml(brl(a.valor))}${a.margemUn != null ? ` · margem ${escaparHtml(brl(a.margemUn))}/un` : ""}`)).join("");
  const chips = relChips("giro", [{ v: "qtd", rot: "Por garrafas" }, { v: "valor", rot: "Por faturamento" }], relOrdemGiro);
  return relSecao("🔥 Maior saída", corpo, chips, `Os ${lista.length} rótulos que mais ${porValor ? "faturaram" : "giraram"} no período.`);
}

function relMargem(ag) {
  const comCusto = ag.filter((a) => a.temCusto);
  if (!comCusto.length) {
    return `<section class="rel-secao">
      <div class="rel-secao-topo"><h3>💰 Maior margem</h3></div>
      <p class="dica rel-dica">Nenhum rótulo vendido no período tem <b>preço de aquisição</b> cadastrado — sem o custo não há como calcular a margem. Cadastre o custo de cada vinho no Estoque.</p>
    </section>`;
  }
  const campo = relOrdemMargem === "unidade" ? "margemUn" : relOrdemMargem === "percentual" ? "margemPct" : "lucro";
  const lista = comCusto.slice().sort((a, b) => b[campo] - a[campo]).slice(0, REL_TOPO);
  // A barra mede o valor absoluto (prejuízo também tem tamanho); o sinal vem escrito e colorido.
  const max = Math.max.apply(null, lista.map((a) => Math.abs(a[campo])));
  const texto = (a) => campo === "margemPct" ? relPct(a.margemPct) : brl(a[campo]);
  const corpo = lista.map((a, i) => relBarra(
    `<span class="rel-pos">${i + 1}º</span> ${escaparHtml(a.nome)}`,
    texto(a), Math.abs(a[campo]), max,
    `${a.qtd} un. · vendido a ${escaparHtml(brl(a.precoMedio))} · custou ${escaparHtml(brl(a.custo))}` +
    (campo === "lucro" ? ` · margem ${escaparHtml(relPct(a.margemPct))}` : ` · lucro ${escaparHtml(brl(a.lucro))}`),
    a[campo] >= 0 ? "lucro" : "prejuizo")).join("");
  const chips = relChips("margem", [
    { v: "lucro", rot: "Lucro total" }, { v: "unidade", rot: "Por garrafa" }, { v: "percentual", rot: "Margem %" },
  ], relOrdemMargem);
  const dicas = {
    lucro: "Quanto cada rótulo deixou de lucro no período (margem × garrafas vendidas).",
    unidade: "Quanto sobra em cada garrafa vendida (preço vendido − custo).",
    percentual: "Quanto de cada real vendido sobrou, antes das despesas.",
  };
  return relSecao("💰 Maior margem", corpo, chips, dicas[relOrdemMargem]);
}

function relPorPeriodo(vendas) {
  const mapa = {};
  // As vendas avulsas são de um dia cada; juntar todas numa barra só evita
  // encher o gráfico de barrinhas de 1 dia e mantém o total batendo com o topo.
  vendas.forEach((v) => {
    const avulsa = vendaAvulsa(v);
    const k = avulsa ? "__avulsas__" : (v.periodoInicio || "") + "||" + (v.periodoFim || "");
    const p = mapa[k] || (mapa[k] = { avulsa, inicio: v.periodoInicio, fim: v.periodoFim, qtd: 0, valor: 0 });
    p.qtd += Number(v.qtd) || 0; p.valor += Number(v.valorVendido) || 0;
    if (avulsa && String(v.periodoInicio) < String(p.inicio)) p.inicio = v.periodoInicio;
  });
  const lista = Object.values(mapa).sort((a, b) => Number(a.avulsa) - Number(b.avulsa) || String(a.inicio).localeCompare(String(b.inicio)));
  if (lista.length < 2) return ""; // um período só: o número do topo já diz tudo
  const max = Math.max.apply(null, lista.map((p) => p.valor));
  const corpo = lista.map((p) => relBarra(
    p.avulsa ? "Vendas avulsas (lançadas à mão)" : escaparHtml(dataBR(p.inicio) + " a " + dataBR(p.fim)),
    brl(p.valor), p.valor, max, `${p.qtd} garrafa${p.qtd === 1 ? "" : "s"}`)).join("");
  return relSecao("Faturamento por período", corpo, "", "Cada barra é um relatório de vendas importado, em ordem de data — e as vendas avulsas somadas à parte.");
}

function relPorAdega(vendas, pdvSel) {
  if (pdvSel !== "__todas__") return "";
  const mapa = {};
  vendas.forEach((v) => {
    const k = v.pdv || "(sem adega)";
    const p = mapa[k] || (mapa[k] = { pdv: k, qtd: 0, valor: 0 });
    p.qtd += Number(v.qtd) || 0; p.valor += Number(v.valorVendido) || 0;
  });
  const lista = Object.values(mapa).sort((a, b) => b.valor - a.valor);
  if (lista.length < 2) return ""; // só faz sentido comparando adegas
  const max = Math.max.apply(null, lista.map((p) => p.valor));
  const corpo = lista.map((p) => relBarra(escaparHtml(p.pdv), brl(p.valor), p.valor, max,
    `${p.qtd} garrafa${p.qtd === 1 ? "" : "s"}`)).join("");
  return relSecao("Faturamento por adega", corpo, "", "Comparação entre as adegas no mesmo período.");
}

// Vinhos que estão na adega e NÃO venderam nada no período (dinheiro parado).
function relParados(ag, pdvSel) {
  const vendidos = new Set(ag.map((a) => a.sku).filter(Boolean));
  const mapa = {};
  DADOS.pdvEstoque.forEach((r) => {
    if (pdvSel !== "__todas__" && r.pdv !== pdvSel) return;
    const q = Number(r.qtd) || 0;
    if (q <= 0 || vendidos.has(r.sku)) return;
    const p = mapa[r.sku] || (mapa[r.sku] = { sku: r.sku, qtd: 0, adegas: [] });
    p.qtd += q;
    if (p.adegas.indexOf(r.pdv) < 0) p.adegas.push(r.pdv);
  });
  const lista = Object.values(mapa).map((p) => {
    const it = DADOS.estoque.find((x) => x.sku === p.sku);
    const custo = it ? Number(it.precoAquisicao) || 0 : 0;
    return Object.assign(p, { nome: (it && it.nome) || p.sku, custo, preso: custo * p.qtd });
  }).sort((a, b) => (b.preso - a.preso) || (b.qtd - a.qtd)).slice(0, REL_TOPO);
  if (!lista.length) return "";
  const max = Math.max.apply(null, lista.map((p) => p.qtd));
  const corpo = lista.map((p) => relBarra(escaparHtml(p.nome), `${p.qtd} na adega`, p.qtd, max,
    (p.preso > 0 ? `${escaparHtml(brl(p.preso))} parados` : "sem custo cadastrado") +
    (p.adegas.length > 1 ? ` · ${escaparHtml(p.adegas.join(", "))}` : ""))).join("");
  return relSecao("🐌 Parados no período", corpo,
    "", "Estão na adega mas <b>não venderam nenhuma garrafa</b> no período — candidatos a promoção ou a sair do mix.");
}

function renderRelatorios() {
  // Seletor de adega (Todas + ativas), preservando a escolha.
  const selP = $("#rel-pdv");
  if (selP) {
    const prev = selP.value;
    selP.innerHTML = `<option value="__todas__">Todas as adegas</option>` +
      pdvsAtivos().map((p) => `<option value="${escaparAttr(p.nome)}">${escaparHtml(p.nome)}</option>`).join("");
    selP.value = (prev && [...selP.options].some((o) => o.value === prev)) ? prev : "__todas__";
  }
  // Datas padrão na 1ª vez: abrange todas as vendas (ou últimos 30 dias).
  const vTodas = DADOS.vendas || [];
  if ($("#rel-de") && !$("#rel-de").value) {
    const ini = vTodas.map((v) => v.periodoInicio).filter(Boolean).sort();
    $("#rel-de").value = ini[0] || isoMenosDias(30);
  }
  if ($("#rel-ate") && !$("#rel-ate").value) {
    const fim = vTodas.map((v) => v.periodoFim).filter(Boolean).sort();
    $("#rel-ate").value = fim[fim.length - 1] || hojeISO();
  }
  const { de, ate, pdv } = relRange();
  const vendas = vendasNoRange(de, ate, pdv);
  const cont = $("#rel-conteudo");
  const vazio = $("#vazio-relatorios");
  if (vazio) vazio.classList.toggle("hidden", vendas.length > 0);
  if (!vendas.length) { cont.innerHTML = ""; return; }
  const ag = relAgregarPorSku(vendas);
  cont.innerHTML = [
    relResumo(ag), relPorTipo(ag), relGiro(ag), relMargem(ag),
    relPorPeriodo(vendas), relPorAdega(vendas, pdv), relParados(ag, pdv),
  ].filter(Boolean).join("");
}
["#rel-pdv", "#rel-de", "#rel-ate"].forEach((s) => { const el0 = $(s); if (el0) el0.addEventListener("change", renderRelatorios); });
// Chips de ordenação (delegado: o conteúdo é recriado a cada render).
{
  const cont = $("#rel-conteudo");
  if (cont) cont.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-rel-grupo]");
    if (!b) return;
    if (b.dataset.relGrupo === "giro") relOrdemGiro = b.dataset.relValor;
    else if (b.dataset.relGrupo === "margem") relOrdemMargem = b.dataset.relValor;
    renderRelatorios();
  });
}

// --- Modal: registrar despesa ---
function abrirModalDespesa() {
  const f = $("#form-despesa"); f.reset();
  f.data.value = hojeISO();
  const filtro = ($("#fin-pdv") && $("#fin-pdv").value) || "__todas__";
  $("#despesa-pdv").innerHTML = pdvsAtivos().map((p) => `<option value="${escaparAttr(p.nome)}">${escaparHtml(p.nome)}</option>`).join("")
    + `<option value="">Geral (todas)</option>`;
  $("#despesa-pdv").value = (filtro && filtro !== "__todas__") ? filtro : pdvAtual;
  abrir("#modal-despesa");
}
$("#btn-add-despesa").addEventListener("click", abrirModalDespesa);
$("#form-despesa").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const despesa = { data: f.data.value || hojeISO(), pdv: f.pdv.value, categoria: f.categoria.value.trim() || "Despesa", descricao: f.descricao.value.trim(), valor: Number(f.valor.value) || 0 };
  if (despesa.valor <= 0) { toast("Informe o valor da despesa"); return; }
  await comProgresso(() => registrarDespesa(despesa));
  fechar("#modal-despesa"); renderGiro(); toast("Despesa registrada ✓");
});

// --- Modal: venda avulsa (fora do sistema da adega) ---------------------
// Lista os vinhos com o disponível de cada lugar, para a sócia ver o que dá
// para vender antes de escolher.
function opcoesVinhoAvulsa(pdv, origem) {
  const daRet = origem === "avulsa-retaguarda";
  return (DADOS.estoque || []).slice()
    .sort((a, b) => String(a.nome).localeCompare(String(b.nome)))
    .map((it) => {
      const disp = daRet ? (Number(it.qtd) || 0) : qtdNoPdv(it.sku, pdv);
      return `<option value="${escaparAttr(it.sku)}">${escaparHtml(it.nome || it.sku)} — ${disp} ${daRet ? "na retaguarda" : "na adega"}</option>`;
    }).join("");
}
// Preenche o preço sugerido e o total, e avisa se não há garrafa suficiente.
function atualizarAvulsa() {
  const f = $("#form-avulsa"); if (!f) return;
  const sku = f.sku.value, pdv = f.pdv.value, origem = f.origem.value;
  const daRet = origem === "avulsa-retaguarda";
  const it = DADOS.estoque.find((x) => x.sku === sku);
  const disp = daRet ? (it ? Number(it.qtd) || 0 : 0) : qtdNoPdv(sku, pdv);
  const qtd = Number(f.qtd.value) || 0;
  const preco = Number(f.preco.value) || 0;
  const r = $("#avulsa-resumo");
  if (!r) return;
  if (qtd > disp) {
    r.innerHTML = `⚠ Só há <b>${disp}</b> ${daRet ? "na retaguarda" : "nesta adega"} — o estoque não pode ficar negativo.`;
    r.className = "dica conf-aviso";
  } else {
    r.innerHTML = `Total da venda: <b>${brl(preco * qtd)}</b> · sai de <b>${daRet ? "retaguarda" : pdv}</b> (${disp} → ${disp - qtd}).`;
    r.className = "dica";
  }
}
function abrirModalVendaAvulsa() {
  if (!(DADOS.estoque || []).length) { toast("Cadastre um vinho no Estoque antes"); return; }
  const f = $("#form-avulsa"); f.reset();
  f.data.value = hojeISO();
  const filtro = ($("#fin-pdv") && $("#fin-pdv").value) || "__todas__";
  $("#avulsa-pdv").innerHTML = opcoesPdv();
  $("#avulsa-pdv").value = (filtro && filtro !== "__todas__") ? filtro : pdvAtual;
  f.origem.value = "avulsa-adega";
  f.qtd.value = 1;
  $("#avulsa-sku").innerHTML = opcoesVinhoAvulsa(f.pdv.value, f.origem.value);
  // Sugere o preço que aquele vinho tem na adega (editável — venda avulsa
  // costuma sair por outro valor).
  f.preco.value = precoVendaNoPdv(f.sku.value, f.pdv.value) || "";
  atualizarAvulsa();
  abrir("#modal-avulsa");
}
$("#btn-add-avulsa").addEventListener("click", abrirModalVendaAvulsa);
["#avulsa-pdv", "#avulsa-origem"].forEach((s) => $(s).addEventListener("change", () => {
  const f = $("#form-avulsa");
  const antes = f.sku.value;
  $("#avulsa-sku").innerHTML = opcoesVinhoAvulsa(f.pdv.value, f.origem.value);
  if (antes && [...f.sku.options].some((o) => o.value === antes)) f.sku.value = antes;
  f.preco.value = precoVendaNoPdv(f.sku.value, f.pdv.value) || f.preco.value;
  atualizarAvulsa();
}));
$("#avulsa-sku").addEventListener("change", () => {
  const f = $("#form-avulsa");
  f.preco.value = precoVendaNoPdv(f.sku.value, f.pdv.value) || f.preco.value;
  atualizarAvulsa();
});
["qtd", "preco"].forEach((n) => $("#form-avulsa")[n].addEventListener("input", atualizarAvulsa));
$("#form-avulsa").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const v = {
    data: f.data.value || hojeISO(), pdv: f.pdv.value, sku: f.sku.value, origem: f.origem.value,
    qtd: Math.floor(Number(f.qtd.value) || 0), preco: Number(f.preco.value) || 0,
  };
  if (!v.sku) { toast("Escolha o vinho"); return; }
  if (v.qtd <= 0) { toast("Informe a quantidade"); return; }
  if (v.preco <= 0) { toast("Informe o preço por garrafa"); return; }
  const it = DADOS.estoque.find((x) => x.sku === v.sku);
  const disp = v.origem === "avulsa-retaguarda" ? (it ? Number(it.qtd) || 0 : 0) : qtdNoPdv(v.sku, v.pdv);
  if (v.qtd > disp) { toast(`Só há ${disp} disponível — ajuste a quantidade`); return; }
  await comProgresso(() => registrarVendaAvulsa(v));
  fechar("#modal-avulsa"); renderGiro(); toast("Venda avulsa registrada ✓");
});

// ======================================================================
//  GUIA DO QR — editar o conteúdo que o cliente vê na porta da adega
// ======================================================================
const ESCALAS_GUIA = {
  docura: ["Bem seco", "Seco", "Meio-seco", "Suave", "Doce", "Bem doce"],
  corpo: ["Muito leve", "Leve", "Médio-leve", "Médio", "Encorpado", "Muito encorpado"],
  taninos: ["Sem taninos", "Bem macio", "Macio", "Médio", "Marcante", "Muito marcante"],
  acidez: ["Baixa", "Média-baixa", "Média", "Média-alta", "Alta", "Muito refrescante"],
};
const ESCALA_TITULO = { docura: "Doçura", corpo: "Corpo", taninos: "Taninos", acidez: "Acidez" };
const filtroGuia = { busca: "", ver: "ativos" };
// Slug da adega no guia do QR. Hoje só a Ecopark; quando entrar a J. PRIME,
// esta escolha vira um seletor (multi-PDV já preparado no resto do app).
const ADEGA_GUIA_SLUG = "ecopark-iv";
// Arquivado = sem nenhuma adega no campo `adegas` (some do guia do cliente,
// mas a ficha + foto ficam guardadas na planilha = a memória do rótulo).
function guiaArquivado(v) { return !String((v && v.adegas) || "").trim(); }

function classeTipoGuia(t) { return classeTipo(t); }
function renderGuia() {
  const cont = $("#lista-guia");
  const q = filtroGuia.busca.trim().toLowerCase();
  const todos = DADOS.guia || [];
  const ativos = todos.filter((v) => !guiaArquivado(v));
  const arquivados = todos.filter((v) => guiaArquivado(v));
  // Contagem nos chips do filtro.
  const fa = $('#guia-filtros [data-ver="ativos"]');
  const fx = $('#guia-filtros [data-ver="arquivados"]');
  if (fa) fa.textContent = `No guia (${ativos.length})`;
  if (fx) fx.textContent = `Memória (${arquivados.length})`;
  $('#guia-filtros [data-ver="ativos"]').classList.toggle("ativo", filtroGuia.ver === "ativos");
  $('#guia-filtros [data-ver="arquivados"]').classList.toggle("ativo", filtroGuia.ver === "arquivados");

  const base = filtroGuia.ver === "arquivados" ? arquivados : ativos;
  let lista = base;
  if (q) lista = lista.filter((v) => `${v.nome} ${v.uva} ${v.produtor} ${v.pais} ${v.codigo || ""}`.toLowerCase().includes(q));
  const rotulo = filtroGuia.ver === "arquivados" ? "na memória" : "no guia";
  $("#guia-info").textContent = todos.length ? `${lista.length} de ${base.length} ${base.length === 1 ? "vinho" : "vinhos"} ${rotulo}` : "";
  $("#vazio-guia").classList.toggle("hidden", todos.length > 0);
  cont.innerHTML = "";
  lista.slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome))).forEach((v) => {
    const arquivado = filtroGuia.ver === "arquivados";
    const card = el("div", "guia-item" + (arquivado ? " arquivado" : ""));
    const thumb = v.foto ? `<img class="guia-foto" src="${escaparAttr(v.foto)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : `<div class="guia-foto vazia">🍷</div>`;
    const noEstoque = (DADOS.estoque || []).some((e) => v.codigo && (mesmoCodigo(e.codigo, v.codigo) || mesmoCodigo(e.codigoBarras, v.codigo)));
    card.innerHTML = `
      ${thumb}
      <div class="guia-corpo">
        <div><span class="tag-tipo ${classeTipoGuia(v.tipo)}">${v.tipo || "—"}</span>
          ${noEstoque ? '<span class="guia-selo">no estoque</span>' : ""}
          ${arquivado ? '<span class="guia-selo arquivado">arquivado</span>' : ""}</div>
        <div class="guia-nome">${escaparHtml(v.nome || "(sem nome)")}</div>
        <div class="guia-sub">${[v.uva, v.pais].filter(Boolean).map(escaparHtml).join(" · ") || "&nbsp;"}</div>
      </div>
      ${arquivado ? '<button type="button" class="btn-secundario guia-reativar">↩ Reativar</button>' : ""}`;
    card.addEventListener("click", () => abrirModalGuia(v));
    if (arquivado) {
      card.querySelector(".guia-reativar").addEventListener("click", (ev) => { ev.stopPropagation(); reativarGuia(v); });
    }
    cont.appendChild(card);
  });
}

function montarEscalasGuia(v) {
  const cont = $("#guia-escalas"); cont.innerHTML = "";
  Object.keys(ESCALAS_GUIA).forEach((k) => {
    const val = Math.max(0, Math.min(5, Number(v && v[k]) || 0));
    const row = el("div", "guia-escala");
    row.innerHTML = `<div class="ge-topo"><span>${ESCALA_TITULO[k]}</span><span class="ge-label" data-l="${k}">${ESCALAS_GUIA[k][val]}</span></div>
      <input type="range" name="${k}" min="0" max="5" step="1" value="${val}" />`;
    row.querySelector("input").addEventListener("input", (e) => {
      row.querySelector(`[data-l="${k}"]`).textContent = ESCALAS_GUIA[k][Number(e.target.value)];
    });
    cont.appendChild(row);
  });
}
// Ajusta os sliders sensoriais já montados (usado pelo preenchimento por IA).
function setEscalasGuia(vals) {
  Object.keys(ESCALAS_GUIA).forEach((k) => {
    if (vals[k] == null) return;
    const val = Math.max(0, Math.min(5, Number(vals[k]) || 0));
    const input = document.querySelector(`#guia-escalas input[name="${k}"]`);
    const label = document.querySelector(`#guia-escalas [data-l="${k}"]`);
    if (input) input.value = val;
    if (label) label.textContent = ESCALAS_GUIA[k][val];
  });
}

// Preenche a ficha do guia por IA a partir do nome do vinho. Devolve as 4 notas
// sensoriais (0-5) + textos. NÃO inventa factual (safra, %álcool, país, região).
async function preencherGuiaIA(dados) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_IA}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const ctx = [`Vinho: ${dados.nome}`,
    dados.produtor ? `Produtor: ${dados.produtor}` : "",
    dados.tipo ? `Tipo: ${dados.tipo}` : "",
    dados.uva ? `Uva: ${dados.uva}` : "",
    dados.pais ? `País: ${dados.pais}` : ""].filter(Boolean).join(" | ");
  const instrucao =
    "Você é sommelier. Preencha uma ficha de guia de vinhos para CLIENTES LEIGOS, em português do Brasil, sobre o vinho do contexto. " +
    "Responda SOMENTE em JSON: " +
    '{"tipo":"Tinto|Branco|Rosé|Espumante","uva":"","docura":0,"corpo":0,"taninos":0,"acidez":0,"gelavel":false,"temperatura":"","harmonizacao":"","queijos":"","descricao":"","combina_se_voce_gosta":""}. ' +
    "As notas são inteiros de 0 a 5: docura (0=bem seco, 5=bem doce); corpo (0=muito leve, 5=muito encorpado); " +
    "taninos (0=sem taninos, 5=muito marcante; use 0 para brancos/espumantes/rosés na maioria); acidez (0=baixa, 5=muito refrescante). " +
    "gelavel=true se fica ótimo bem gelado (brancos, rosés, espumantes e alguns tintos leves). " +
    "temperatura = faixa em °C (ex.: '16–18 °C'). harmonizacao = pratos que combinam (frase curta). queijos = queijos que combinam. " +
    "descricao = 2 a 3 frases simpáticas e claras pro cliente, descrevendo o estilo REAL (frutado, amadeirado, herbáceo, macio, adstringente…). " +
    "IMPORTANTE: seja fiel ao estilo — NÃO diga que é frutado se o estilo não for; muitos vinhos são pouco frutados, mais adstringentes ou amadeirados. " +
    "combina_se_voce_gosta = complete a frase 'Combina se você gosta…' (ex.: 'de tinto encorpado para churrasco'). " +
    "Preencha 'uva' só se tiver segurança pelo nome; senão deixe ''. NÃO invente safra, teor alcoólico, país nem região (não estão nesta ficha). " +
    "Se não conhecer o rótulo exato, faça a melhor estimativa pelo estilo indicado no nome/uva/tipo. Contexto — " + ctx;
  const body = { contents: [{ parts: [{ text: instrucao }] }], generationConfig: { temperature: 0.3, responseMimeType: "application/json" } };
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || "erro da IA");
  const texto = json.candidates && json.candidates[0] && json.candidates[0].content
    && json.candidates[0].content.parts && json.candidates[0].content.parts[0].text;
  if (!texto) throw new Error("a IA não respondeu");
  let d; try { d = JSON.parse(texto); } catch (_) { throw new Error("resposta da IA fora do formato"); }
  return d;
}

function abrirModalGuia(v) {
  const f = $("#form-guia");
  f.reset();
  const editando = !!v;
  $("#modal-guia-titulo").textContent = editando ? "Editar vinho do guia" : "Novo vinho no guia";
  $("#btn-excluir-guia").classList.toggle("hidden", !editando);
  const arq = editando && guiaArquivado(v);
  const btnArq = $("#btn-arquivar-guia");
  btnArq.classList.toggle("hidden", !editando);
  btnArq.textContent = arq ? "↩ Reativar no guia" : "Tirar do guia";
  f.id_original.value = editando ? (v.id || "") : "";
  if (f.id) f.id.value = editando ? (v.id || "") : "";
  const camposTexto = ["nome", "codigo", "produtor", "uva", "pais", "regiao", "safra", "alcool", "temperatura", "harmonizacao", "queijos", "descricao", "combina_se_voce_gosta", "foto", "adegas"];
  camposTexto.forEach((c) => { if (f[c]) f[c].value = editando ? (v[c] != null ? v[c] : "") : ""; });
  f.tipo.value = (editando && v.tipo) ? v.tipo : "Tinto";
  f.gelavel.checked = editando ? (v.gelavel === true || v.gelavel === "sim" || v.gelavel === "SIM") : false;
  if (!editando) f.adegas.value = "ecopark-iv";
  montarEscalasGuia(editando ? v : {});
  // Foto: mostra a atual (se for dataURL/URL absoluta) e zera o estado de aprovação
  guiaFotoProcessada = null;
  $("#guia-foto-aprovar").classList.add("hidden");
  mostrarThumbGuia(editando && v.foto && /^(data:|https?:)/.test(v.foto) ? v.foto : "");
  atualizarDatalists();
  abrir("#modal-guia");
}

// Ao digitar o nome, se casar com um rótulo do estoque, sugere o código.
function vincularCodigoGuia() {
  const f = $("#form-guia");
  if (f.codigo.value.trim()) return;
  const alvo = normTexto(f.nome.value);
  const it = (DADOS.estoque || []).find((e) => normTexto(e.nome) === alvo && alvo);
  if (it && it.codigo) f.codigo.value = it.codigo;
}

// Preencher a ficha do guia por IA (o humano só revisa e ajusta depois).
$("#btn-guia-ia").addEventListener("click", async () => {
  const f = $("#form-guia");
  if (!f.nome.value.trim()) { toast("Escreva o nome do vinho primeiro"); f.nome.focus(); return; }
  if (!GEMINI_KEY) { toast("Configure a chave da IA na engrenagem ⚙ primeiro"); $("#btn-config").click(); return; }
  const btn = $("#btn-guia-ia");
  const orig = btn.textContent; btn.disabled = true; btn.textContent = "✨ Consultando…";
  try {
    const d = await preencherGuiaIA({ nome: f.nome.value.trim(), produtor: f.produtor.value.trim(), tipo: f.tipo.value, uva: f.uva.value.trim(), pais: f.pais.value.trim() });
    // Textos: só preenche os campos VAZIOS (preserva o que você já digitou).
    const soVazio = (campo, val) => { if (f[campo] && !f[campo].value.trim() && val) f[campo].value = String(val); };
    if (d.tipo && ["Tinto", "Branco", "Rosé", "Espumante"].includes(d.tipo)) f.tipo.value = d.tipo;
    soVazio("uva", d.uva);
    soVazio("temperatura", d.temperatura);
    soVazio("harmonizacao", d.harmonizacao);
    soVazio("queijos", d.queijos);
    soVazio("descricao", d.descricao);
    soVazio("combina_se_voce_gosta", d.combina_se_voce_gosta);
    if (typeof d.gelavel === "boolean") f.gelavel.checked = d.gelavel;
    setEscalasGuia(d); // as 4 notas sensoriais sempre atualizam (estimativa da IA)
    toast("Preenchido pela IA ✓ — revise e ajuste antes de salvar");
  } catch (err) {
    console.error(err); toast("Não consegui preencher: " + (err.message || "tente de novo"));
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
});

$("#form-guia").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const orig = DADOS.guia.find((x) => x.id === f.id_original.value) || {};
  const vinho = {
    ...orig,
    id: (f.id ? f.id.value.trim() : "") || orig.id || "", nome: f.nome.value.trim(), codigo: f.codigo.value.trim(), produtor: f.produtor.value.trim(),
    tipo: f.tipo.value, uva: f.uva.value.trim(), pais: f.pais.value.trim(), regiao: f.regiao.value.trim(),
    safra: f.safra.value.trim(), alcool: f.alcool.value.trim(),
    docura: Number(f.docura.value) || 0, corpo: Number(f.corpo.value) || 0, taninos: Number(f.taninos.value) || 0, acidez: Number(f.acidez.value) || 0,
    gelavel: f.gelavel.checked ? "sim" : "", temperatura: f.temperatura.value.trim(),
    harmonizacao: f.harmonizacao.value.trim(), queijos: f.queijos.value.trim(), descricao: f.descricao.value.trim(),
    combina_se_voce_gosta: f.combina_se_voce_gosta.value.trim(), foto: f.foto.value.trim(), adegas: f.adegas.value.trim(),
  };
  if (!vinho.nome) return;
  await comProgresso(() => salvarVinhoGuia(vinho, f.id_original.value || null));
  fechar("#modal-guia"); await recarregar(); irPara("guia"); toast("Vinho do guia salvo ✓");
});

// Arquivar = esvaziar `adegas` (some do guia do cliente, ficha + foto ficam
// guardadas na planilha). Reativar = repor o slug da adega atual. Ambos usam o
// salvarVinhoGuia que já existe → NÃO precisa reimplantar o backend.
async function arquivarGuia(v) {
  await comProgresso(() => salvarVinhoGuia({ ...v, adegas: "" }, v.id));
  fechar("#modal-guia"); await recarregar(); irPara("guia"); toast("Guardado na memória de rótulos");
}
async function reativarGuia(v) {
  const adegas = String(v.adegas || "").trim() || ADEGA_GUIA_SLUG;
  await comProgresso(() => salvarVinhoGuia({ ...v, adegas }, v.id));
  filtroGuia.ver = "ativos";
  fechar("#modal-guia"); await recarregar(); irPara("guia"); toast("Vinho de volta ao guia ✓");
}

$("#btn-arquivar-guia").addEventListener("click", async () => {
  const id = $("#form-guia").id_original.value;
  const v = (DADOS.guia || []).find((x) => x.id === id);
  if (!v) return;
  if (guiaArquivado(v)) { reativarGuia(v); return; }
  if (!confirm("Tirar este vinho do guia do QR?\nA ficha e a foto ficam guardadas na memória — dá pra reativar quando o rótulo voltar.\n(Não mexe no seu estoque.)")) return;
  arquivarGuia(v);
});

$("#btn-excluir-guia").addEventListener("click", async () => {
  const id = $("#form-guia").id_original.value;
  if (!id) return;
  if (!confirm("Excluir este vinho DE VEZ?\nApaga a ficha e a foto da memória (não dá pra reativar).\n(Não mexe no seu estoque.)")) return;
  await comProgresso(() => excluirVinhoGuia(id));
  fechar("#modal-guia"); await recarregar(); toast("Vinho excluído do guia");
});

$("#guia-filtros").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ver]");
  if (!b) return;
  filtroGuia.ver = b.dataset.ver;
  renderGuia();
});

$("#busca-guia").addEventListener("input", (e) => { filtroGuia.busca = e.target.value; renderGuia(); });
$("#btn-novo-guia").addEventListener("click", () => abrirModalGuia(null));
$("#form-guia").nome.addEventListener("change", vincularCodigoGuia);

// ---- Foto da garrafa: IA isola em fundo transparente + padroniza o tamanho ----
const MODELO_IMG = "gemini-2.5-flash-image"; // "Nano Banana" — edita imagem
let guiaFotoProcessada = null; // dataURL da foto pronta, aguardando aprovação

function mostrarThumbGuia(src) {
  const t = $("#guia-foto-thumb");
  t.innerHTML = src ? `<img src="${escaparAttr(src)}" alt="" />` : "🍷";
  t.classList.toggle("vazia", !src);
}

let camStream = null;
function podeFoto() {
  if (!GEMINI_KEY) { toast("Configure a chave da IA na engrenagem ⚙ primeiro"); $("#btn-config").click(); return false; }
  const f = $("#form-guia");
  if (!f.nome.value.trim()) { toast("Preencha o nome do vinho antes da foto"); f.nome.focus(); return false; }
  return true;
}
$("#btn-foto-guia").addEventListener("click", () => { if (podeFoto()) abrirCamera(); });
$("#btn-foto-refazer").addEventListener("click", () => { if (podeFoto()) abrirCamera(); });

// Abre a câmera ao vivo (câmera de trás no celular). Se não houver câmera
// (ou o usuário negar), cai direto no seletor de arquivo.
async function abrirCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $("#input-foto-guia").click(); return; }
  abrir("#modal-camera");
  $("#cam-status").textContent = "Abrindo a câmera…";
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const v = $("#cam-video"); v.srcObject = camStream; $("#cam-status").textContent = "";
  } catch (e) {
    console.warn(e); fecharCamera();
    toast("Câmera indisponível aqui — escolha um arquivo");
    $("#input-foto-guia").click();
  }
}
function fecharCamera() {
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  const v = $("#cam-video"); if (v) v.srcObject = null;
  fechar("#modal-camera");
}
$("#btn-cam-arquivo").addEventListener("click", () => { fecharCamera(); $("#input-foto-guia").click(); });
$("#btn-cam-capturar").addEventListener("click", () => {
  const v = $("#cam-video");
  if (!v || !v.videoWidth) { toast("A câmera ainda não está pronta"); return; }
  let w = v.videoWidth, h = v.videoHeight;
  const max = 1600; if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(v, 0, 0, w, h);
  const base64 = cv.toDataURL("image/jpeg", 0.9).split(",")[1];
  fecharCamera();
  processarFotoIA(base64, "image/jpeg");
});

$("#input-foto-guia").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const { base64, mime } = await prepararArquivo(file);
    await processarFotoIA(base64, mime);
  } catch (err) { console.error(err); toast("Não consegui ler a foto: " + (err.message || "tente outra")); }
});

// IA isola a garrafa → app padroniza o tamanho → mostra para aprovar.
async function processarFotoIA(base64, mime) {
  try {
    $("#carregando-msg").textContent = "Deixando a garrafa no padrão (IA)…";
    abrir("#carregando");
    const editada = await editarFotoGarrafaIA(base64, mime);
    const padronizada = await padronizarGarrafa("data:" + (editada.mime || "image/png") + ";base64," + editada.base64);
    fechar("#carregando");
    guiaFotoProcessada = padronizada;
    mostrarThumbGuia(padronizada);
    $("#guia-foto-aprovar").classList.remove("hidden");
  } catch (err) {
    fechar("#carregando"); console.error(err);
    toast("Não consegui processar a foto: " + (err.message || "tente outra"));
  }
}

$("#btn-foto-usar").addEventListener("click", async () => {
  if (!guiaFotoProcessada) return;
  const f = $("#form-guia");
  if (!f.id.value.trim()) f.id.value = gerarIdGuia(f.nome.value);
  const id = f.id.value.trim();
  try {
    const base64 = guiaFotoProcessada.split(",")[1];
    if (online()) {
      $("#carregando-msg").textContent = "Enviando a foto para o guia…";
      abrir("#carregando");
      const r = await apiPost("salvarFotoGuia", { id, base64 });
      fechar("#carregando");
      // caminho relativo no site do guia + quebra de cache
      f.foto.value = (r && r.path ? r.path : `fotos/${id}.png`) + "?v=" + Date.now();
    } else {
      // demo: guarda a própria imagem no campo (sem repositório)
      f.foto.value = guiaFotoProcessada;
    }
    $("#guia-foto-aprovar").classList.add("hidden");
    guiaFotoProcessada = null;
    toast("Foto pronta ✓ — salve o vinho para publicar");
  } catch (err) {
    fechar("#carregando"); console.error(err);
    toast("Não consegui enviar a foto: " + (err.message || "tente de novo"));
  }
});

// Chama o Gemini de imagem: manda a foto + comando, recebe a imagem editada.
async function editarFotoGarrafaIA(base64, mime) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_IMG}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const instrucao =
    "Recorte APENAS a GARRAFA de vinho desta foto, como um adesivo/sticker PNG. " +
    "O fundo DEVE ficar 100% TRANSPARENTE (canal alfa vazio): NÃO deixe fundo branco, NÃO deixe nenhum retângulo, cor sólida, gradiente ou cenário atrás da garrafa. " +
    "Onde não há garrafa, os pixels devem ser transparentes — nada de branco. " +
    "Mostre a garrafa inteira, em pé, centralizada, estilo foto de produto de catálogo, iluminação suave e uniforme, sem sombra no chão, sem reflexos exagerados. " +
    "Mantenha o RÓTULO fiel ao original (não invente texto). Não adicione bordas, texto ou marca d'água. Devolva apenas a imagem (PNG com transparência real).";
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: instrucao }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || "erro da IA");
  const parts = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
  const imgPart = parts.find((p) => p.inline_data || p.inlineData);
  const dados = imgPart && (imgPart.inline_data || imgPart.inlineData);
  if (!dados || !dados.data) throw new Error("a IA não devolveu imagem");
  return { base64: dados.data, mime: dados.mime_type || dados.mimeType || "image/png" };
}

// Padroniza: recorta a garrafa, escala para uma altura fixa e centraliza num
// quadro do mesmo tamanho (fundo transparente) — garante todas do mesmo tamanho.
function padronizarGarrafa(dataUrl, alvoW = 600, alvoH = 800, alturaAlvo = 740) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.width, h = img.height;
      const tc = document.createElement("canvas"); tc.width = w; tc.height = h;
      const tx = tc.getContext("2d"); tx.drawImage(img, 0, 0);
      let dados; try { dados = tx.getImageData(0, 0, w, h); } catch (_) { resolve(dataUrl); return; }
      const px = dados.data;
      // Tem transparência de verdade? (algum pixel com alpha baixo)
      let temAlpha = false;
      for (let i = 3; i < px.length; i += 4) { if (px[i] < 245) { temAlpha = true; break; } }
      const bg = [px[0], px[1], px[2]]; // cor do canto superior esquerdo (fundo)
      const tol = 40;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          let fg;
          if (temAlpha) { fg = px[i + 3] > 40; }
          else {
            const dr = px[i] - bg[0], dg = px[i + 1] - bg[1], db = px[i + 2] - bg[2];
            fg = Math.sqrt(dr * dr + dg * dg + db * db) > tol;
            if (!fg) px[i + 3] = 0; // deixa o fundo transparente
          }
          if (fg) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        }
      }
      if (!temAlpha) tx.putImageData(dados, 0, 0);
      if (maxX < minX || maxY < minY) { resolve(dataUrl); return; }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const escala = alturaAlvo / bh;
      const dw = Math.min(alvoW, bw * escala), dh = bh * escala;
      const out = document.createElement("canvas"); out.width = alvoW; out.height = alvoH;
      const ox = out.getContext("2d");
      ox.drawImage(tc, minX, minY, bw, bh, (alvoW - dw) / 2, (alvoH - dh) / 2, dw, dh);
      resolve(out.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ======================================================================
//  MODAL — CONEXÃO (link + senha da planilha, guardado só neste aparelho)
// ======================================================================
$("#btn-config").addEventListener("click", () => {
  const f = $("#form-config");
  f.url.value = API_URL; f.token.value = API_TOKEN; f.geminiKey.value = GEMINI_KEY;
  if (f.guiaUrl) f.guiaUrl.value = GUIA_URL;
  $("#config-status").textContent = "";
  abrir("#modal-config");
});

$("#btn-testar").addEventListener("click", async () => {
  const f = $("#form-config");
  const url = f.url.value.trim(), token = f.token.value.trim();
  const st = $("#config-status");
  if (!url) { st.textContent = "Cole o link do app primeiro."; return; }
  st.textContent = "Testando…";
  try {
    const gu = f.guiaUrl ? f.guiaUrl.value.trim() : "";
    const gsid = (gu.match(/\/d\/([a-zA-Z0-9\-_]+)/) || [])[1] || "";
    const ggid = (gu.match(/[?#&]gid=(\d+)/) || [])[1] || "";
    let u = `${url}?token=${encodeURIComponent(token)}`;
    if (gsid) u += `&guiaId=${encodeURIComponent(gsid)}&guiaGid=${encodeURIComponent(ggid)}`;
    const resp = await fetch(u, { cache: "no-store" });
    const json = await resp.json();
    if (json.erro) throw new Error(json.erro);
    const nEst = (json.estoque || []).length;
    const nGuia = (json.guia || []).length;
    st.textContent = `✓ Conectou! ${nEst} ${nEst === 1 ? "item" : "itens"} no estoque` + (gsid ? ` · ${nGuia} no guia` : "") + ".";
  } catch (err) { st.textContent = "✗ Não conectou: " + (err.message || "confira o link/senha"); }
});

$("#form-config").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const cfg = { url: f.url.value.trim(), token: f.token.value.trim(), geminiKey: f.geminiKey.value.trim(), guiaUrl: f.guiaUrl ? f.guiaUrl.value.trim() : GUIA_URL };
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  carregarConfig(); marcarModo();
  fechar("#modal-config");
  try { await carregar(); } catch (err) { console.error(err); }
  irPara("estoque"); atualizarDatalists();
  toast(online() ? "Conectado à planilha ✓" : "Modo demonstração");
});

// --- Configuração por arquivo (onboarding fácil das sócias) ---
// O dono preenche uma vez, "Baixar meu arquivo" gera um .json; manda pras
// sócias (WhatsApp etc.); elas "Carregar arquivo" → preenche + testa → Salvar.
function baixarConfigArquivo() {
  const f = $("#form-config");
  const cfg = {
    app: "vinho24h-gestao", tipo: "config",
    url: f.url.value.trim(), token: f.token.value.trim(),
    geminiKey: f.geminiKey.value.trim(), guiaUrl: f.guiaUrl ? f.guiaUrl.value.trim() : "",
  };
  if (!cfg.url && !cfg.token) { $("#config-status").textContent = "Preencha os campos antes de baixar o arquivo."; return; }
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "vinho24h-config.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  $("#config-status").textContent = "Arquivo baixado ✓ — mande pras sócias. (Contém a senha e a chave; compartilhe só com quem é de confiança.)";
}

async function carregarConfigArquivo(file) {
  const st = $("#config-status");
  try {
    const txt = await file.text();
    const c = JSON.parse(txt);
    if (c.tipo && c.tipo !== "config") throw new Error("tipo");
    const f = $("#form-config");
    if (c.url != null) f.url.value = String(c.url).trim();
    if (c.token != null) f.token.value = String(c.token).trim();
    if (c.geminiKey != null) f.geminiKey.value = String(c.geminiKey).trim();
    if (f.guiaUrl && c.guiaUrl != null) f.guiaUrl.value = String(c.guiaUrl).trim();
    st.textContent = "Configuração carregada — testando…";
    $("#btn-testar").click();
  } catch (err) {
    st.textContent = "✗ Não consegui ler esse arquivo. Peça um arquivo de configuração novo (.json).";
  }
}

$("#btn-config-baixar").addEventListener("click", baixarConfigArquivo);
$("#btn-config-carregar").addEventListener("click", () => $("#input-config-arquivo").click());
$("#input-config-arquivo").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) carregarConfigArquivo(file);
  e.target.value = "";
});

// ======================================================================
//  NAVEGAÇÃO / HELPERS DE UI
// ======================================================================
function irPara(aba) {
  if (aba !== "estoque" && modoSelecao) { modoSelecao = false; selecionados.clear(); $("#selecao-barra").classList.add("hidden"); }
  $$(".aba").forEach((s) => s.classList.add("hidden"));
  $(`#aba-${aba}`).classList.remove("hidden");
  $$(".nav-btn[data-aba]").forEach((b) => b.classList.toggle("ativo", b.dataset.aba === aba));
  if (aba === "estoque") renderEstoque();
  else if (aba === "compras") renderCompras();
  else if (aba === "ofertas") renderOfertas();
  else if (aba === "giro") renderGiro();
  else if (aba === "relatorios") renderRelatorios();
  else if (aba === "guia") renderGuia();
  window.scrollTo(0, 0);
}
$$(".nav-btn[data-aba]").forEach((b) => b.addEventListener("click", () => irPara(b.dataset.aba)));
$("#fab-add").addEventListener("click", () => abrirModalItem(null));
$("#btn-add-vazio").addEventListener("click", () => abrirModalItem(null));
$("#btn-nova-compra").addEventListener("click", abrirModalCompra);

// Filtros do estoque
function montarFiltros() {
  const chips = [
    { rot: "🍷 Tinto", tipo: "Tinto" }, { rot: "🥂 Branco", tipo: "Branco" },
    { rot: "🌸 Rosé", tipo: "Rosé" }, { rot: "✨ Espumante", tipo: "Espumante" },
    { rot: "⚠ Repor", baixo: true },
  ];
  const cont = $("#filtros"); cont.innerHTML = "";
  chips.forEach((c) => {
    const b = el("button", "chip" + (c.baixo ? " chip-baixo" : ""), c.rot);
    b.addEventListener("click", () => {
      if (c.baixo) filtro.baixo = !filtro.baixo;
      else filtro.tipo = filtro.tipo === c.tipo ? null : c.tipo;
      $$("#filtros .chip").forEach((x, i) => {
        const cc = chips[i];
        x.classList.toggle("ativo", cc.baixo ? filtro.baixo : filtro.tipo === cc.tipo);
      });
      renderEstoque();
    });
    cont.appendChild(b);
  });
}
$("#busca").addEventListener("input", (e) => { filtro.busca = e.target.value; renderEstoque(); });

// Modais: abrir/fechar
function abrir(sel) { $(sel).classList.remove("hidden"); document.body.style.overflow = "hidden"; }
function fechar(sel) {
  if (sel === "#modal-camera" && typeof camStream !== "undefined" && camStream) {
    camStream.getTracks().forEach((t) => t.stop()); camStream = null;
    const v = $("#cam-video"); if (v) v.srcObject = null;
  }
  $(sel).classList.add("hidden"); document.body.style.overflow = "";
}
$$(".modal-overlay").forEach((ov) => {
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.hasAttribute("data-fecha")) fechar("#" + ov.id); });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $$(".modal-overlay:not(.hidden)").forEach((ov) => fechar("#" + ov.id));
});

// Toast + indicador de modo + progresso
let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}
function marcarModo() {
  const m = $("#topo-modo");
  m.className = "topo-modo " + (online() ? "online" : "demo");
  m.innerHTML = `<span class="ponto"></span>${online() ? "Planilha" : "Demonstração"}`;
}
async function comProgresso(fn) {
  try { await fn(); }
  catch (err) { console.error(err); toast("Erro: " + (err.message || "tente de novo")); throw err; }
}
// Re-renderiza a aba atual a partir do estado local (instantâneo).
function renderAtual() {
  const btn = $(".nav-btn[data-aba].ativo");
  const aba = btn ? btn.dataset.aba : "estoque";
  if (aba === "compras") renderCompras();
  else if (aba === "ofertas") renderOfertas();
  else if (aba === "giro") renderGiro();
  else if (aba === "relatorios") renderRelatorios();
  else if (aba === "guia") renderGuia();
  else renderEstoque();
  atualizarDatalists();
}
// Depois de uma escrita otimista, só re-renderiza (os dados locais já mudaram).
// A sincronização com o servidor acontece em 2º plano (ver sincronizarFundo).
async function recarregar() { renderAtual(); }
// Força buscar do servidor (usado após imports pesados). Espera a fila drenar
// pra não ler dados no meio de uma escrita pendente.
async function recarregarDoServidor() {
  if (online()) {
    try { await _filaSync; await carregar(); }
    catch (e) { console.error(e); toast("Não consegui atualizar do servidor"); }
  }
  renderAtual();
}

// Escape para conteúdo vindo de fora (links/nomes) usado com innerHTML.
function escaparHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escaparAttr(s) { return escaparHtml(s).replace(/"/g, "&quot;"); }

// ======================================================================
//  DADOS DE EXEMPLO (só no modo demonstração, na 1ª vez)
// ======================================================================
function SEED() {
  // Sem vinhos de exemplo — o app começa vazio para você cadastrar os seus.
  return { fornecedores: [], vigiados: [], precos: [], compras: [], estoque: [], lojas: [],
    pdvs: [{ nome: "Ecopark", ativo: "sim" }], pdvEstoque: [], vendas: [], guia: [] };
}

// ======================================================================
//  INÍCIO
// ======================================================================
async function iniciar() {
  marcarModo();
  montarFiltros();
  montarFiltrosOfertas();
  // CACHE-FIRST: mostra NA HORA o que estava salvo no aparelho...
  const cache = lerLocal();
  DADOS = cache || SEED();
  normalizarDados();
  irPara("estoque");
  // ...e atualiza do servidor em 2º plano (se online). A tela re-renderiza sozinha.
  if (online()) {
    try { await carregar(); renderAtual(); }
    catch (err) {
      console.error(err);
      toast(cache ? "Sem conexão agora — mostrando os dados salvos" : "Não consegui ler a planilha — confira o SETUP.");
    }
  }
}

// Service worker (PWA / offline)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

iniciar();
