# Como ligar o app na planilha (e depois na IA)

O app **já funciona sozinho** em *modo demonstração* (dados salvos só no celular).
Isso é ótimo pra testar. Quando quiser que **você, a esposa e a sócia vejam o
mesmo estoque** de qualquer celular, siga a **Fase 1** abaixo. A leitura de nota
por foto/IA é a **Fase 2** (opcional, quando quiser).

> ⚠️ Esta é uma planilha **NOVA e separada** da planilha do guia de vinhos (a do
> QR Code). Não mexa naquela. Aqui é só gestão interna (estoque/compras).

---

## Fase 1 — Ligar na planilha (grátis, ~15 min)

### 1) Criar a planilha nova
1. Acesse **sheets.google.com** → **planilha em branco**.
2. Dê o nome, ex.: **"Vinho 24H — Gestão (estoque)"**.
3. Crie **3 abas** (as abas ficam embaixo; clique no `+`). Renomeie para:
   `Estoque`, `Compras`, `Fornecedores`.
4. Na **primeira linha** de cada aba, coloque exatamente estes cabeçalhos
   (uma palavra por célula, da esquerda pra direita):

   **Aba `Estoque`:**
   ```
   sku | nome | tipo | uva | produtor | qtd | minimo | precoAquisicao | fornecedor | dataCompra | obs
   ```
   **Aba `Compras`:**
   ```
   data | nome | qtd | precoUnit | fornecedor | notaChave
   ```
   **Aba `Fornecedores`:**
   ```
   nome | contato | obs
   ```

   > Atalho: dá pra importar o arquivo **`seed-estoque.csv`** (Arquivo →
   > Importar → na aba Estoque) que já vem com esses cabeçalhos e 3 exemplos.

### 2) Colar o "mini-servidor" (Apps Script)
1. Na planilha: menu **Extensões → Apps Script**.
2. Apague o código de exemplo e **cole todo o conteúdo de `apps-script.gs`**.
3. Clique no disquete (salvar).

### 3) Criar a senha (TOKEN)
1. No Apps Script, ícone de **engrenagem** (Configurações do projeto).
2. Em **Propriedades do script → Adicionar propriedade**:
   - Propriedade: `TOKEN`  → Valor: uma senha qualquer (ex.: `adega2026segredo`)
3. Salvar. **Anote essa senha**, você vai colar no app.

### 4) Publicar como App da Web
1. Botão azul **Implantar → Nova implantação**.
2. Em "Selecione o tipo" (engrenagem) → **App da Web**.
3. Configure:
   - **Executar como:** Eu (sua conta)
   - **Quem pode acessar:** Qualquer pessoa
4. **Implantar**. O Google vai pedir pra **autorizar** (é normal: é seu próprio
   script acessando sua própria planilha — clique em Avançado → Acessar).
5. Copie o **link do app da Web** (termina em **`/exec`**).

### 5) Ligar no app (pela tela de conexão — sem mexer no código)
1. Abra o app no celular e toque na **engrenagem ⚙** (canto superior direito).
2. Cole o **link do app (/exec)** e a **senha (TOKEN)** e toque em **Testar**.
   - Deu "✓ Conectou!" → toque em **Salvar**.
3. Pronto: o cabeçalho mostra **"● Planilha"** em vez de "● Demonstração".
4. **Cada pessoa** (você, esposa, sócia) faz isso **uma vez** no próprio celular.

> 🔒 Por que assim? O link e a senha ficam guardados **só no aparelho**, nunca
> dentro do site publicado. Assim ninguém consegue descobrir e mexer no seu
> estoque só por abrir o app.

> Mudou o código do Apps Script depois? Faça **Implantar → Gerenciar
> implantações → editar (lápis) → Nova versão**. O link `/exec` continua o mesmo.

---

## Fase 2 — Leitura de nota fiscal por foto/PDF (IA)

Isso usa a IA do Claude para ler a nota e preencher as compras. Custa **centavos
por nota** (você paga direto à Anthropic pelo uso).

1. Crie uma chave em **console.anthropic.com** → *API Keys* → *Create Key*.
   Coloque alguns dólares de crédito (o uso por nota é muito baixo).
2. No Apps Script → engrenagem → **Propriedades do script**, adicione:
   - Propriedade: `CLAUDE_API_KEY` → Valor: a chave (começa com `sk-ant-...`)
3. Faça **Implantar → Gerenciar implantações → Nova versão** (pra valer a chave).
4. Me avise: eu ligo o botão **"📷 Ler nota fiscal"** do app na câmera/PDF
   (o código do lado do servidor já está pronto no `apps-script.gs`).

> A chave da IA fica **guardada no Apps Script**, nunca no site público — então
> ninguém consegue roubá-la abrindo o app. É o jeito seguro de fazer.

---

## Dúvidas comuns

- **"Apareceu erro de token"** → a senha em `API_TOKEN` (app.js) tem que ser
  idêntica à propriedade `TOKEN` (Apps Script).
- **"Não atualiza na hora"** → o app relê a planilha a cada ação; se editar a
  planilha na mão, recarregue o app.
- **"Quero voltar pro modo demonstração"** → deixe `API_URL = ""` no app.js.
