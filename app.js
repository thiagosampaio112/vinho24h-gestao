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
// Modelo da IA usada para ler as notas. Pode trocar se quiser outro.
const MODELO_IA = "gemini-2.5-flash";
function carregarConfig() {
  try { const c = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); API_URL = c.url || ""; API_TOKEN = c.token || ""; GEMINI_KEY = c.geminiKey || ""; } catch (_) {}
}
carregarConfig();

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
let DADOS = { estoque: [], compras: [], fornecedores: [], vigiados: [], precos: [] };
const filtro = { busca: "", tipo: null, baixo: false };
const LS_KEY = "vinho24h_gestao_dados_v2";

// ======================================================================
//  CAMADA DE DADOS  (Apps Script quando online; localStorage no demo)
// ======================================================================
async function apiGet() {
  const resp = await fetch(`${API_URL}?token=${encodeURIComponent(API_TOKEN)}`, { cache: "no-store" });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return await resp.json();
}
async function apiPost(action, payload) {
  // text/plain evita o "preflight" de CORS que o Apps Script não responde bem.
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, token: API_TOKEN, ...payload }),
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const json = await resp.json();
  if (json && json.erro) throw new Error(json.erro);
  return json;
}

function lerLocal() {
  try { const s = localStorage.getItem(LS_KEY); if (s) return JSON.parse(s); } catch (_) {}
  return null;
}
function gravarLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(DADOS)); } catch (_) {} }

async function carregar() {
  if (online()) {
    DADOS = await apiGet();
  } else {
    DADOS = lerLocal() || SEED();
  }
  DADOS.estoque = DADOS.estoque || []; DADOS.compras = DADOS.compras || []; DADOS.fornecedores = DADOS.fornecedores || [];
  DADOS.vigiados = DADOS.vigiados || []; DADOS.precos = DADOS.precos || []; DADOS.lojas = DADOS.lojas || [];
}

// Gera um SKU simples quando o item não tem um.
function novoSku(nome) {
  const semAcento = (nome || "item").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const base = semAcento.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  let sku = base || "item", i = 2;
  while (DADOS.estoque.some((x) => x.sku === sku)) sku = `${base}-${i++}`;
  return sku;
}

// --- Operações (roteiam para API ou local) ---
async function salvarItem(item, skuOriginal) {
  if (!item.sku) item.sku = novoSku(item.nome);
  if (online()) { await apiPost("salvarItem", { item, skuOriginal }); }
  else {
    const lista = DADOS.estoque;
    const idx = lista.findIndex((x) => x.sku === (skuOriginal || item.sku));
    if (idx >= 0) lista[idx] = { ...lista[idx], ...item }; else lista.push(item);
    registrarFornecedor(item.fornecedor); gravarLocal();
  }
}
async function excluirItem(sku) {
  if (online()) { await apiPost("excluirItem", { sku }); }
  else { DADOS.estoque = DADOS.estoque.filter((x) => x.sku !== sku); gravarLocal(); }
}
async function ajustarQtd(sku, delta) {
  const item = DADOS.estoque.find((x) => x.sku === sku); if (!item) return;
  const nova = Math.max(0, (Number(item.qtd) || 0) + delta);
  if (online()) { await apiPost("ajustarQtd", { sku, qtd: nova }); item.qtd = nova; }
  else { item.qtd = nova; gravarLocal(); }
}
async function registrarCompra(compra) {
  if (online()) { await apiPost("registrarCompra", { compra }); }
  else {
    DADOS.compras.unshift(compra);
    // Atualiza estoque: soma quantidade e guarda último preço/fornecedor.
    let item = DADOS.estoque.find((x) => x.nome.toLowerCase() === compra.nome.toLowerCase());
    if (item) {
      item.qtd = (Number(item.qtd) || 0) + Number(compra.qtd);
      if (compra.precoUnit) item.precoAquisicao = compra.precoUnit;
      if (compra.fornecedor) item.fornecedor = compra.fornecedor;
      if (compra.data) item.dataCompra = compra.data;
    } else {
      DADOS.estoque.push({ sku: novoSku(compra.nome), nome: compra.nome, tipo: "Tinto", uva: "", produtor: "",
        qtd: Number(compra.qtd), minimo: 3, precoAquisicao: compra.precoUnit || 0,
        fornecedor: compra.fornecedor || "", dataCompra: compra.data || "", obs: "" });
    }
    registrarFornecedor(compra.fornecedor); gravarLocal();
  }
}
function registrarFornecedor(nome) {
  nome = (nome || "").trim(); if (!nome) return;
  if (!DADOS.fornecedores.some((f) => (f.nome || f) === nome)) DADOS.fornecedores.push({ nome });
}

async function excluirCompra(compra) {
  if (online()) { await apiPost("excluirCompra", { linha: compra.__row }); }
  else { const i = DADOS.compras.indexOf(compra); if (i >= 0) DADOS.compras.splice(i, 1); gravarLocal(); }
}

// --- Lojas de confiança (radar de preço, Fase 3B) ---
function siteDe(url) { const m = String(url || "").match(/^https?:\/\/([^/]+)/i); return m ? m[1].replace(/^www\./i, "") : String(url || ""); }

async function salvarLoja(loja, urlOriginal) {
  if (!loja.nome) loja.nome = siteDe(loja.url);
  if (!loja.ativo) loja.ativo = "sim";
  if (online()) { await apiPost("salvarLoja", { loja, urlOriginal }); }
  else {
    const alvo = urlOriginal || loja.url;
    const idx = DADOS.lojas.findIndex((l) => l.url === alvo);
    if (idx >= 0) DADOS.lojas[idx] = { ...DADOS.lojas[idx], ...loja }; else DADOS.lojas.push(loja);
    gravarLocal();
  }
}
async function excluirLoja(url) {
  if (online()) { await apiPost("excluirLoja", { url }); }
  else { DADOS.lojas = DADOS.lojas.filter((l) => l.url !== url); gravarLocal(); }
}


// ======================================================================
//  RENDER — ESTOQUE
// ======================================================================
function itensFiltrados() {
  const q = filtro.busca.trim().toLowerCase();
  return DADOS.estoque.filter((v) => {
    if (filtro.tipo && v.tipo !== filtro.tipo) return false;
    if (filtro.baixo && !estaBaixo(v)) return false;
    if (q) {
      const alvo = `${v.nome} ${v.uva} ${v.produtor} ${v.fornecedor} ${v.sku}`.toLowerCase();
      if (!alvo.includes(q)) return false;
    }
    return true;
  });
}
const estaBaixo = (v) => (Number(v.qtd) || 0) <= (Number(v.minimo) || 0);

function renderResumo() {
  const est = DADOS.estoque;
  const itens = est.length;
  const garrafas = est.reduce((s, v) => s + (Number(v.qtd) || 0), 0);
  const valor = est.reduce((s, v) => s + (Number(v.qtd) || 0) * (Number(v.precoAquisicao) || 0), 0);
  const baixos = est.filter(estaBaixo).length;
  $("#painel-resumo").innerHTML = `
    <div class="resumo-caixa"><span class="num">${garrafas}</span><span class="rot">garrafas</span></div>
    <div class="resumo-caixa"><span class="num">${brl(valor)}</span><span class="rot">investido</span></div>
    <div class="resumo-caixa ${baixos ? "alerta" : ""}"><span class="num">${baixos}</span><span class="rot">em falta</span></div>`;
  void itens;
}

function classeTipo(t) { return { Tinto: "tag-tinto", Branco: "tag-branco", "Rosé": "tag-rose", Espumante: "tag-espumante" }[t] || "tag-tinto"; }

function renderEstoque() {
  renderResumo();
  const lista = itensFiltrados();
  const grade = $("#grade");
  const vazio = $("#vazio-estoque");
  grade.innerHTML = "";
  grade.classList.toggle("modo-selecao", modoSelecao);
  $("#resultado-info").textContent = `${lista.length} ${lista.length === 1 ? "item" : "itens"}`;
  $("#btn-selecionar").classList.toggle("hidden", modoSelecao || DADOS.estoque.length === 0);

  if (DADOS.estoque.length === 0) { vazio.classList.remove("hidden"); return; }
  vazio.classList.add("hidden");

  lista.forEach((v) => {
    const sel = modoSelecao && selecionados.has(v.sku);
    const item = el("div", "item" + (estaBaixo(v) ? " baixo" : "") + (sel ? " selecionado" : ""));
    const qtd = Number(v.qtd) || 0;
    item.innerHTML = `
      <div class="item-check"></div>
      <div class="item-info">
        <div><span class="tag-tipo ${classeTipo(v.tipo)}">${v.tipo || "—"}</span>
          ${estaBaixo(v) ? '<span class="selo-baixo">⚠ Repor</span>' : ""}</div>
        <div class="item-nome">${v.nome || "(sem nome)"}</div>
        <div class="item-linha2">${[v.uva, v.produtor].filter(Boolean).join(" · ") || "&nbsp;"}</div>
        <div class="item-meta">
          <span>Compra: <b>${v.precoAquisicao ? brl(v.precoAquisicao) : "—"}</b></span>
          <span>Fornec.: <b>${v.fornecedor || "—"}</b></span>
          <span>Desde: <b>${dataBR(v.dataCompra)}</b></span>
        </div>
      </div>
      <div class="item-qtd">
        <div class="qtd-num">${qtd}<small>un.</small></div>
        <div class="qtd-botoes">
          <button class="qtd-btn menos" aria-label="Diminuir">−</button>
          <button class="qtd-btn mais" aria-label="Aumentar">+</button>
        </div>
      </div>`;
    if (modoSelecao) {
      item.querySelector(".item-info").addEventListener("click", () => alternarSelecao(v.sku));
    } else {
      item.querySelector(".item-info").addEventListener("click", () => abrirModalItem(v));
      item.querySelector(".menos").addEventListener("click", async () => { await ajustarQtd(v.sku, -1); renderEstoque(); });
      item.querySelector(".mais").addEventListener("click", async () => { await ajustarQtd(v.sku, +1); renderEstoque(); });
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
  } else { f.dataCompra.value = hojeISO(); }
  atualizarDatalists();
  abrir("#modal-item");
}

$("#form-item").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const item = {
    sku: f.sku.value.trim(), nome: f.nome.value.trim(), tipo: f.tipo.value, uva: f.uva.value.trim(),
    produtor: f.produtor.value.trim(), qtd: Number(f.qtd.value) || 0, minimo: Number(f.minimo.value) || 0,
    precoAquisicao: Number(f.precoAquisicao.value) || 0, dataCompra: f.dataCompra.value,
    fornecedor: f.fornecedor.value.trim(), obs: f.obs.value.trim(),
  };
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
    "Responda em JSON no formato: {\"fornecedor\":\"\",\"data\":\"AAAA-MM-DD\",\"itens\":[{\"nome\":\"\",\"qtd\":0,\"precoUnit\":0}]}. " +
    "nome = descrição do produto (limpa, sem códigos). qtd = quantidade (número). precoUnit = valor unitário em reais (número, ponto decimal). " +
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

// ---- Modal de conferência dos itens lidos ----
function abrirModalNota(nota) {
  const f = $("#form-nota");
  f.reset();
  f.fornecedor.value = nota.fornecedor || "";
  f.data.value = (nota.data && /^\d{4}-\d{2}-\d{2}$/.test(nota.data)) ? nota.data : hojeISO();
  const itens = Array.isArray(nota.itens) ? nota.itens : [];
  $("#nota-itens").innerHTML = `<div class="nota-cab"><span>Produto</span><span>Qtd</span><span>Unit. R$</span><span></span></div>`;
  if (itens.length === 0) linhaItemNota({});
  else itens.forEach((it) => linhaItemNota(it));
  atualizarDatalists();
  abrir("#modal-nota");
}

function linhaItemNota(it) {
  const div = el("div", "nota-item");
  div.innerHTML = `
    <input class="i-nome" type="text" value="${(it.nome || "").replace(/"/g, "&quot;")}" placeholder="Nome do vinho" />
    <input class="i-qtd" type="number" min="0" step="1" inputmode="numeric" value="${Number(it.qtd) || ""}" placeholder="0" />
    <input class="i-preco" type="number" min="0" step="0.01" inputmode="decimal" value="${Number(it.precoUnit) || ""}" placeholder="0,00" />
    <button type="button" class="nota-x" aria-label="Remover">✕</button>`;
  div.querySelector(".nota-x").addEventListener("click", () => div.remove());
  $("#nota-itens").appendChild(div);
}

$("#btn-add-item-nota").addEventListener("click", () => linhaItemNota({}));

$("#form-nota").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const fornecedor = f.fornecedor.value.trim();
  const data = f.data.value || hojeISO();
  const linhas = $$("#nota-itens .nota-item");
  const compras = [];
  linhas.forEach((l) => {
    const nome = l.querySelector(".i-nome").value.trim();
    const qtd = Number(l.querySelector(".i-qtd").value) || 0;
    const precoUnit = Number(l.querySelector(".i-preco").value) || 0;
    if (nome && qtd > 0) compras.push({ nome, qtd, precoUnit, fornecedor, data, notaChave: "" });
  });
  if (compras.length === 0) { toast("Preencha ao menos um item (nome e quantidade)"); return; }
  await comProgresso(async () => { for (const c of compras) await registrarCompra(c); });
  fechar("#modal-nota"); await recarregar(); irPara("compras");
  toast(`${compras.length} ${compras.length === 1 ? "compra salva" : "compras salvas"} ✓`);
});

// ======================================================================
//  MODAL — CONEXÃO (link + senha da planilha, guardado só neste aparelho)
// ======================================================================
$("#btn-config").addEventListener("click", () => {
  const f = $("#form-config");
  f.url.value = API_URL; f.token.value = API_TOKEN; f.geminiKey.value = GEMINI_KEY;
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
    const resp = await fetch(`${url}?token=${encodeURIComponent(token)}`, { cache: "no-store" });
    const json = await resp.json();
    if (json.erro) throw new Error(json.erro);
    st.textContent = `✓ Conectou! ${(json.estoque || []).length} itens na planilha.`;
  } catch (err) { st.textContent = "✗ Não conectou: " + (err.message || "confira o link/senha"); }
});

$("#form-config").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const cfg = { url: f.url.value.trim(), token: f.token.value.trim(), geminiKey: f.geminiKey.value.trim() };
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  carregarConfig(); marcarModo();
  fechar("#modal-config");
  try { await carregar(); } catch (err) { console.error(err); }
  irPara("estoque"); atualizarDatalists();
  toast(online() ? "Conectado à planilha ✓" : "Modo demonstração");
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
function fechar(sel) { $(sel).classList.add("hidden"); document.body.style.overflow = ""; }
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
async function recarregar() {
  if (online()) await carregar();
  const btn = $(".nav-btn[data-aba].ativo");
  const aba = btn ? btn.dataset.aba : "estoque";
  if (aba === "compras") renderCompras();
  else if (aba === "ofertas") renderOfertas();
  else renderEstoque();
  atualizarDatalists();
}

// Escape para conteúdo vindo de fora (links/nomes) usado com innerHTML.
function escaparHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escaparAttr(s) { return escaparHtml(s).replace(/"/g, "&quot;"); }

// ======================================================================
//  DADOS DE EXEMPLO (só no modo demonstração, na 1ª vez)
// ======================================================================
function SEED() {
  // Sem vinhos de exemplo — o app começa vazio para você cadastrar os seus.
  return { fornecedores: [], vigiados: [], precos: [], compras: [], estoque: [] };
}

// ======================================================================
//  INÍCIO
// ======================================================================
async function iniciar() {
  marcarModo();
  montarFiltros();
  montarFiltrosOfertas();
  try { await carregar(); }
  catch (err) { console.error(err); toast("Não consegui ler a planilha — confira o SETUP."); DADOS = lerLocal() || SEED(); }
  irPara("estoque");
}

// Service worker (PWA / offline)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

iniciar();
