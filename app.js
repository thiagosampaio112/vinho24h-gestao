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

// >>> COLE AQUI o link do Apps Script publicado (termina em /exec). Ex.:
// const API_URL = "https://script.google.com/macros/s/AKfy.../exec";
const API_URL = "";
// Token combinado com o Apps Script (qualquer senha; a MESMA nos dois lados).
const API_TOKEN = "";

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
let DADOS = { estoque: [], compras: [], fornecedores: [] };
const filtro = { busca: "", tipo: null, baixo: false };
const LS_KEY = "vinho24h_gestao_dados";

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
    DADOS.estoque = DADOS.estoque || []; DADOS.compras = DADOS.compras || []; DADOS.fornecedores = DADOS.fornecedores || [];
  } else {
    DADOS = lerLocal() || SEED();
  }
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
  $("#resultado-info").textContent = `${lista.length} ${lista.length === 1 ? "item" : "itens"}`;

  if (DADOS.estoque.length === 0) { vazio.classList.remove("hidden"); return; }
  vazio.classList.add("hidden");

  lista.forEach((v) => {
    const item = el("div", "item" + (estaBaixo(v) ? " baixo" : ""));
    const qtd = Number(v.qtd) || 0;
    item.innerHTML = `
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
    item.querySelector(".item-info").addEventListener("click", () => abrirModalItem(v));
    item.querySelector(".menos").addEventListener("click", async () => { await ajustarQtd(v.sku, -1); renderEstoque(); });
    item.querySelector(".mais").addEventListener("click", async () => { await ajustarQtd(v.sku, +1); renderEstoque(); });
    grade.appendChild(item);
  });
}

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
      </div>
      <div class="compra-sub">${c.qtd} un. × ${brl(c.precoUnit)} · ${c.fornecedor || "sem fornecedor"} · ${dataBR(c.data)}</div>`;
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
//  LER NOTA FISCAL (Fase 2 — precisa da chave da IA no Apps Script)
// ======================================================================
$("#btn-ler-nota").addEventListener("click", () => {
  alert(
    "📷 Leitura de nota fiscal — Fase 2\n\n" +
    "Assim que você configurar o Apps Script com a chave da IA (Claude), " +
    "este botão vai abrir a câmera / PDF, ler os itens da nota e preencher " +
    "as compras automaticamente para você só conferir e salvar.\n\n" +
    "Por enquanto, use \"+ Compra manual\". Passo a passo no arquivo SETUP.md."
  );
});

// ======================================================================
//  NAVEGAÇÃO / HELPERS DE UI
// ======================================================================
function irPara(aba) {
  $$(".aba").forEach((s) => s.classList.add("hidden"));
  $(`#aba-${aba}`).classList.remove("hidden");
  $$(".nav-btn[data-aba]").forEach((b) => b.classList.toggle("ativo", b.dataset.aba === aba));
  if (aba === "estoque") renderEstoque(); else renderCompras();
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
async function recarregar() { if (online()) await carregar(); const ativa = $("#aba-compras").classList.contains("hidden") ? "estoque" : "compras"; if (ativa === "estoque") renderEstoque(); else renderCompras(); atualizarDatalists(); }

// ======================================================================
//  DADOS DE EXEMPLO (só no modo demonstração, na 1ª vez)
// ======================================================================
function SEED() {
  const d = {
    fornecedores: [{ nome: "Distribuidora Central" }, { nome: "Importadora Sul" }],
    compras: [
      { nome: "Malbec Reserva", qtd: 12, precoUnit: 28.5, fornecedor: "Importadora Sul", data: hojeISO(), notaChave: "" },
    ],
    estoque: [
      { sku: "malbec-reserva", nome: "Malbec Reserva", tipo: "Tinto", uva: "Malbec", produtor: "Bodega Andina", qtd: 12, minimo: 4, precoAquisicao: 28.5, fornecedor: "Importadora Sul", dataCompra: hojeISO(), obs: "" },
      { sku: "chardonnay-classico", nome: "Chardonnay Clássico", tipo: "Branco", uva: "Chardonnay", produtor: "Vinícola Vale", qtd: 2, minimo: 4, precoAquisicao: 24.0, fornecedor: "Distribuidora Central", dataCompra: hojeISO(), obs: "Gira rápido no verão" },
      { sku: "rose-verao", nome: "Rosé de Verão", tipo: "Rosé", uva: "Pinot Noir", produtor: "Casa Rosada", qtd: 6, minimo: 3, precoAquisicao: 31.9, fornecedor: "Importadora Sul", dataCompra: hojeISO(), obs: "" },
    ],
  };
  return d;
}

// ======================================================================
//  INÍCIO
// ======================================================================
async function iniciar() {
  marcarModo();
  montarFiltros();
  try { await carregar(); }
  catch (err) { console.error(err); toast("Não consegui ler a planilha — confira o SETUP."); DADOS = lerLocal() || SEED(); }
  irPara("estoque");
}

// Service worker (PWA / offline)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

iniciar();
