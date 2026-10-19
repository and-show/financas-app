# Finanças — app para lançar gastos na planilha (versão 2)

Página para o celular que grava direto na planilha **Finanças Out/26 – Set/27**.

O que ela faz:
- **Resumo do mês** no topo: saldo do mês atual e quanto do cartão já comprometeu da renda, com a marca do seu limite.
- **Escrever o gasto** (com IA do Gemini): digite "uber 23,50 débito" ou "tênis 300 em 3x mãe" e o app preenche tudo. Você confere e salva.
- **Três tipos de lançamento:**
  - **Cartão:** à vista, parcelado ou fixa. Vai para a aba Parcelamentos e aparece sozinho nos meses.
  - **Gasto do mês:** vai para "Gastos do Mês" da aba do mês.
  - **Entrada:** vai para o quadro de Entradas da aba do mês.
- **Atalhos:** os gastos que você mais lança viram botões de um toque.
- **Últimos lançamentos com Desfazer:** se errou, toca em Desfazer e a linha sai da planilha.
- **Tela Resumo** (precisa do `Code.gs` novo, veja "Atualizar o script"):
  - saldo, entradas, saídas e sobra de qualquer mês, com setas para navegar;
  - gastos **por categoria**, com aviso quando passa do "Valor esperado" da planilha. Tocar numa categoria filtra os lançamentos;
  - **por cartão / forma**, com a marca de pago ou a pagar;
  - **sobra prevista no ano**: um gráfico com os 12 meses do Panorama anual (tem também a versão em tabela);
  - todos os lançamentos do mês (fixos, gastos do mês e cartão) e as entradas.
- **Tela Parcelas:** quanto do cartão já está comprometido por mês, quanto falta pagar, as **próximas 6 faturas**, quando termina cada parcelamento e o botão **Encerrar** para assinaturas fixas.
- **Modo privado (👁):** borra os valores para abrir o app em público.
- **Funciona sem internet:** sem sinal, o lançamento fica guardado no celular e vai sozinho quando a conexão voltar. O topo mostra quando os dados foram atualizados; toque ali para atualizar.

Arquivos:
- `apps-script/Code.gs`: o servidor, que fica dentro da planilha.
- `index.html`, `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`: o site, que vai para o GitHub.

---

## Parte 1 — Script na planilha

1. Na planilha: **Extensões → Apps Script**. Apague o código antigo e cole todo o `apps-script/Code.gs`.
2. Na função `configurar` (no topo do arquivo), preencha:
   - `PIN`: um PIN seu (obrigatório).
   - `GEMINI_KEY`: sua chave do Gemini, criada no Google AI Studio (opcional, liga o "escrever o gasto").
3. Salve, escolha **configurar** no menu de funções e clique em **Executar**. Autorize quando o Google pedir.
4. **Importante:** depois de rodar, apague a chave do código e salve de novo. Ela já ficou guardada nas propriedades do script.
5. **Implantar:**
   - **Primeira vez:** Implantar → Nova implantação → App da Web. Executar como: **Eu**. Quem pode acessar: **Qualquer pessoa**. Copie o endereço que termina em `/exec`.
   - **Se já tinha a versão 1:** Implantar → **Gerenciar implantações** → lápis → Versão: **Nova versão** → Implantar. O endereço continua o mesmo.

### Atualizar o script (para a tela Resumo)

A tela Resumo usa uma leitura nova do script (`painel`). Sem ela, o app continua funcionando e o Resumo mostra só o mês atual, com um aviso.

1. **Extensões → Apps Script**, apague o código e cole o `apps-script/Code.gs` novo. **Não precisa rodar `configurar` de novo**: o PIN e a chave continuam guardados.
2. **Implantar → Gerenciar implantações** → lápis → Versão: **Nova versão** → Implantar. O endereço `/exec` continua o mesmo.

> Se o "Preencher" der erro de modelo do Gemini, vá em ⚙️ Configurações do projeto → Propriedades do script e crie `GEMINI_MODEL` com o nome de um modelo atual que sua chave aceite.

## Parte 2 — Site no GitHub

1. No repositório, envie **todos** estes arquivos: `index.html`, `sw.js`, `manifest.webmanifest`, `icon-192.png` e `icon-512.png`. Se já tinha a versão 1, substitua o `index.html`.
2. Em **Settings → Pages**, deixe Branch `main` e pasta `/ (root)`.
3. O site fica em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

## Parte 3 — No celular

1. Abra o site, toque em ⚙︎ e cole o endereço `/exec` e o PIN.
2. Instale como app:
   - **Android (Chrome):** menu ⋮ → **Instalar app** ou **Adicionar à tela inicial**.
   - **iPhone (Safari):** Compartilhar → **Adicionar à Tela de Início**.

## Segurança

- O repositório pode ser público, porque nenhum arquivo do site tem senha ou chave.
- O PIN e o endereço ficam só no seu celular. A chave do Gemini fica só nas propriedades do script, na sua conta Google.
- Sem o PIN, o script recusa tudo.
- O app cria uma aba oculta **App_Log** na planilha, com o histórico dos lançamentos. É ela que permite o Desfazer e os atalhos. Não apague.

## Problemas comuns

- **"PIN incorreto":** o PIN dos Ajustes não bate com o do `configurar`.
- **"Não existe a aba Out/27":** a data cai num mês que a planilha ainda não tem.
- **Desfazer diz que "a linha foi alterada":** você mexeu nela pela planilha. Apague por lá.
- **Mudou algo no `Code.gs` e não fez efeito:** faltou implantar uma **nova versão**.
