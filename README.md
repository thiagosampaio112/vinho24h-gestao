# Vinho 24 Horas · Gestão

App interno (PWA instalável no celular) para **gestão das adegas**: estoque,
preço de aquisição, fornecedor, data de compra, histórico de compras e — na
Fase 2 — leitura de nota fiscal por foto/PDF com IA.

> É um projeto **separado** do guia de vinhos por QR Code (aquele que o cliente
> lê na porta da adega). Aqui é só para o casal e a sócia gerenciarem o negócio.
> Nada se mistura: outra pasta, outro app, outra planilha.

## O que já faz (Fase 1)
- 📦 **Estoque**: lista de garrafas com quantidade, preço de compra, fornecedor,
  data e mínimo de alerta. Botões **+ / −** para dar entrada/baixa rápida.
- 🔴 **Alerta de reposição**: destaca e filtra os itens que estão no/abaixo do mínimo.
- 📊 **Resumo**: total de garrafas, valor investido e quantos itens estão em falta.
- 🧾 **Compras**: registro manual de compras (entra no histórico e soma no estoque).
- 📱 **Instalável** no celular e funciona **offline**.

## Como testar agora
Abra o `index.html` no navegador (ou no celular pela URL publicada). Ele já roda
em **modo demonstração** com dados de exemplo — sem configurar nada. Cada
aparelho guarda seus próprios dados até você ligar a planilha.

## Para usar de verdade (compartilhado entre celulares)
Siga o **[SETUP.md](SETUP.md)** — Fase 1 liga o app na sua planilha Google nova.
A Fase 2 (leitura de nota por IA) é opcional e vem depois.

## Arquivos
| Arquivo | Para quê |
|---|---|
| `index.html`, `styles.css`, `app.js` | o app em si (HTML/CSS/JS puro, sem build) |
| `apps-script.gs` | o "mini-servidor" para colar no Google Apps Script |
| `SETUP.md` | passo a passo de instalação (planilha + IA) |
| `seed-estoque.csv` | cabeçalhos + exemplos para importar na aba Estoque |
| `manifest.webmanifest`, `sw.js`, `icons/` | o que torna o app instalável/offline |

## Roadmap
- **Fase 2** ✅ — leitura de nota fiscal por foto/PDF com IA (Google Gemini),
  com tela de conferência antes de salvar. Falta (futuro): ler QR Code da NF-e.
- **Fase 3** — pesquisa de preços em vários sites (comparar se comprou bem).
