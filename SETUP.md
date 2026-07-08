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

## Fase 2 — Leitura de nota fiscal por foto/PDF (IA) — JÁ FUNCIONA

Usa a IA do **Google Gemini** para ler a nota e preencher as compras. Tem um
**limite gratuito** generoso; se um dia passar, é pré-pago por uso (centavos por
nota) e só cobra se você cadastrar cartão. **Não precisa mexer no Apps Script**
para isso — a leitura roda direto no celular.

1. Pegue uma chave em **aistudio.google.com/apikey** → *Criar chave de API*
   (começa com `AIza…`). Guarde.
   - *(Opcional)* Para tirar o risco de estourar o limite, cadastre um cartão em
     **console.cloud.google.com → Faturamento**; sem cartão, funciona no grátis.
2. No app, toque na **engrenagem ⚙** → cole a chave no campo **"Chave da IA
   (Gemini)"** → **Salvar**. (Fica guardada só neste aparelho.)
3. Vá na aba **Compras → "📷 Ler nota fiscal"** → tire a foto ou escolha o PDF.
4. A IA lê os itens; você **confere/ajusta** na tela e toca **Salvar compras**.
   Cada item entra no histórico e soma no estoque.

> 🔒 A chave da IA fica **só no seu celular** (não no site publicado). Cada
> pessoa que for ler notas cola a própria chave uma vez.

> 💡 Dica: foto reta, boa luz e a nota inteira no quadro = leitura melhor. Para
> nota fiscal eletrônica (NF-e), o PDF costuma dar resultado mais preciso que a foto.

---

## Dúvidas comuns

- **"Apareceu erro de token"** → a senha em `API_TOKEN` (app.js) tem que ser
  idêntica à propriedade `TOKEN` (Apps Script).
- **"Não atualiza na hora"** → o app relê a planilha a cada ação; se editar a
  planilha na mão, recarregue o app.
- **"Quero voltar pro modo demonstração"** → deixe `API_URL = ""` no app.js.
