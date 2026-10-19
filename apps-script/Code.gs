/**
 * Finanças — servidor do app "Lançar gasto" (versão 2)
 * Cole em: Planilha > Extensões > Apps Script  (substitua o código antigo)
 * Passos completos no README.
 */

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const FUSO = 'America/Fortaleza';
// Ordem de tentativa: o Pro mais recente primeiro; se não estiver disponível na sua chave, cai para o Flash.
const MODELOS_GEMINI = ['gemini-pro-latest', 'gemini-3.1-pro-preview', 'gemini-flash-latest'];

/* =========================================================
 * 1) CONFIGURAÇÃO — preencha, rode "configurar" uma vez e
 *    depois apague a chave daqui (ela fica guardada).
 * ========================================================= */
function configurar() {
  const valores = {
    PIN: 'TROQUE-ESTE-PIN',   // obrigatório
    GEMINI_KEY: ''            // opcional: sua chave do Gemini (liga o "escrever o gasto")
  };
  const p = PropertiesService.getScriptProperties();
  Object.keys(valores).forEach(k => {
    const v = String(valores[k]).trim();
    if (v && v !== 'TROQUE-ESTE-PIN') p.setProperty(k, v);
  });
  Logger.log('PIN: ' + (p.getProperty('PIN') ? 'ok' : 'FALTANDO'));
  Logger.log('Gemini: ' + (p.getProperty('GEMINI_KEY') ? 'ok' : 'desligado'));
}

/* =========================================================
 * Entradas HTTP
 * ========================================================= */
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (!pinOk(p.pin)) return json({ ok: false, erro: 'PIN incorreto.' });
    if (p.acao === 'painel') return json({ ok: true, painel: painel(p.aba) });
    return json(Object.assign({ ok: true }, inicio()));
  } catch (err) {
    return json({ ok: false, erro: String(err.message || err) });
  }
}

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); }
  catch (err) { return json({ ok: false, erro: 'Os dados chegaram em formato inválido.' }); }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (!pinOk(d.pin)) return json({ ok: false, erro: 'PIN incorreto.' });
    let r;
    if (d.acao === 'salvar') r = salvar(d, 'app');
    else if (d.acao === 'desfazer') r = desfazer(d.uid);
    else if (d.acao === 'encerrar') r = encerrar(d.id, d.mes);
    else if (d.acao === 'interpretar') return json({ ok: true, lancamento: interpretar(d.texto) });
    else return json({ ok: false, erro: 'Ação desconhecida.' });
    return json(Object.assign({ ok: true }, r, { dados: inicio() }));
  } catch (err) {
    return json({ ok: false, erro: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* Tudo que a tela inicial do app precisa, numa chamada só */
function inicio() {
  return {
    cartoes: lista('Configurações', 'D4:D20').filter(c => c !== 'Conta'),
    categorias: lista('Configurações', 'A4:A30'),
    resumo: resumo(),
    recentes: recentes(),
    atalhos: atalhos(),
    parcelamentos: parcelamentosAtivos(),
    ia: !!prop('GEMINI_KEY')
  };
}

/* =========================================================
 * Salvar lançamentos
 * ========================================================= */
function salvar(d, origem) {
  const log = abaLog();
  if (d.uid) {
    const uids = log.getRange(2, 1, Math.max(log.getLastRow() - 1, 1), 1).getValues().flat();
    if (uids.includes(d.uid)) return { msg: 'Esse lançamento já estava salvo.' };
  }
  let r;
  if (d.tipo === 'cartao') r = salvarCartao(d);
  else if (d.tipo === 'gasto') r = salvarGasto(d);
  else if (d.tipo === 'entrada') r = salvarEntrada(d);
  else throw new Error('Tipo de lançamento desconhecido.');

  log.appendRow([
    d.uid || Utilities.getUuid(), new Date(), origem, d.tipo, "'" + r.aba, r.linha, r.ref || '',   // ' = guarda "Out/26" como texto, não como data
    d.descricao.trim(), Number(d.valor), d.cartao || '', d.categoria || '', 'ok'
  ]);
  return { msg: r.msg };
}

function salvarCartao(d) {
  validar(d, ['descricao', 'valor', 'cartao', 'categoria', 'mes']);
  const sh = planilha().getSheetByName('Parcelamentos');
  const dados = sh.getRange('A2:B100').getValues();
  let linha = -1, maiorId = 0;
  dados.forEach((r, i) => {
    const m = String(r[0]).match(/PAR-(\d+)/);
    if (m) maiorId = Math.max(maiorId, Number(m[1]));
    if (linha === -1 && r[1] === '') linha = i + 2;
  });
  if (linha === -1) throw new Error('A aba Parcelamentos está cheia (linha 100).');

  const id = 'PAR-' + String(maiorId + 1).padStart(3, '0');
  const [ano, mes] = d.mes.split('-').map(Number);
  const parcelas = d.parcelas === 'fixa' ? '' : Number(d.parcelas || 1);
  sh.getRange(linha, 1, 1, 7).setValues([[id, d.descricao.trim(), d.cartao, d.categoria, Number(d.valor), parcelas, new Date(ano, mes - 1, 1)]]);
  sh.getRange(linha, 10).setValue('Lançado pelo app em ' + Utilities.formatDate(new Date(), FUSO, 'dd/MM/yyyy'));

  const qtd = parcelas === '' ? 'fixa' : parcelas === 1 ? 'à vista' : parcelas + 'x';
  return { aba: 'Parcelamentos', linha, ref: id, msg: `${d.descricao.trim()} (${qtd}) entra a partir de ${nomeAba(ano, mes)}.` };
}

function salvarGasto(d) {
  validar(d, ['descricao', 'valor', 'cartao', 'categoria', 'data']);
  const [ano, mes, dia] = d.data.split('-').map(Number);
  const aba = nomeAba(ano, mes);
  const sh = abaMes(aba);
  const i = sh.getRange('K10:K54').getValues().findIndex(r => r[0] === '');
  if (i === -1) throw new Error(`A lista de gastos de ${aba} está cheia.`);
  const linha = 10 + i;
  sh.getRange(linha, 11, 1, 5).setValues([[d.descricao.trim(), new Date(ano, mes - 1, dia), d.cartao, d.categoria, Number(d.valor)]]);
  return { aba, linha, msg: `${d.descricao.trim()} salvo em ${aba}.` };
}

function salvarEntrada(d) {
  validar(d, ['descricao', 'valor', 'data']);
  const [ano, mes] = d.data.split('-').map(Number);
  const aba = nomeAba(ano, mes);
  const sh = abaMes(aba);
  const i = sh.getRange('Q9:Q14').getValues().findIndex(r => r[0] === '');
  if (i === -1) throw new Error(`As entradas de ${aba} já têm 6 itens. Some algumas na planilha.`);
  const linha = 9 + i;
  sh.getRange(linha, 17, 1, 2).setValues([[d.descricao.trim(), Number(d.valor)]]);
  return { aba, linha, msg: `Entrada ${d.descricao.trim()} salva em ${aba}.` };
}

/* =========================================================
 * Desfazer e encerrar
 * ========================================================= */
function desfazer(uid) {
  const log = abaLog();
  const n = log.getLastRow() - 1;
  if (n < 1) throw new Error('Nada para desfazer.');
  const vals = log.getRange(2, 1, n, 12).getValues();
  const i = vals.findIndex(r => r[0] === uid && r[11] === 'ok');
  if (i === -1) throw new Error('Esse lançamento já foi desfeito ou não existe.');
  const [, , , tipo, abaLida, linha, , descricao] = vals[i];
  const aba = textoAba(abaLida);
  const sh = planilha().getSheetByName(aba);
  if (!sh) throw new Error(`A aba ${aba} não existe mais.`);

  const colDesc = tipo === 'cartao' ? 2 : tipo === 'gasto' ? 11 : 17;
  if (String(sh.getRange(linha, colDesc).getValue()).trim() !== String(descricao).trim()) {
    throw new Error(`A linha ${linha} de ${aba} foi alterada na planilha. Apague por lá.`);
  }
  if (tipo === 'cartao') { sh.getRange(linha, 1, 1, 7).clearContent(); sh.getRange(linha, 10).clearContent(); }
  if (tipo === 'gasto') sh.getRange(linha, 11, 1, 5).clearContent();
  if (tipo === 'entrada') sh.getRange(linha, 17, 1, 2).clearContent();
  log.getRange(i + 2, 12).setValue('desfeito');
  return { msg: `${descricao} foi desfeito.` };
}

function encerrar(id, mesFinal) {
  if (!id || !mesFinal) throw new Error('Informe o parcelamento e o último mês.');
  const sh = planilha().getSheetByName('Parcelamentos');
  const ids = sh.getRange('A2:A100').getValues().flat();
  const i = ids.indexOf(id);
  if (i === -1) throw new Error(`Não achei ${id} em Parcelamentos.`);
  const linha = i + 2;
  const inicio = sh.getRange(linha, 7).getValue();
  const [ano, mes] = mesFinal.split('-').map(Number);
  const qtd = (ano - inicio.getFullYear()) * 12 + (mes - 1 - inicio.getMonth()) + 1;
  if (qtd < 1) throw new Error('O último mês não pode ser antes da primeira cobrança.');
  sh.getRange(linha, 6).setValue(qtd);
  if (linha < 15) sh.getRange(linha, 8).setValue(new Date(ano, mes - 1, 1)); // linhas antigas têm a data final digitada
  const desc = sh.getRange(linha, 2).getValue();
  return { msg: `${desc} encerrado. Última cobrança em ${nomeAba(ano, mes)}.` };
}

/* =========================================================
 * Leituras para a tela
 * ========================================================= */
function resumo() {
  const hoje = new Date();
  const aba = nomeAba(hoje.getFullYear(), hoje.getMonth() + 1);
  const sh = planilha().getSheetByName(aba);
  if (!sh) return null;
  const n = a1 => Number(sh.getRange(a1).getValue()) || 0;
  const entradas = n('R15'), cartao = n('G23');
  return {
    aba, saldo: n('R2'), entradas, cartao, gastos: n('N6'), previstos: n('R26'),
    limite: Number(planilha().getSheetByName('Configurações').getRange('G11').getValue()) || 0.5,
    pct: entradas > 0 ? cartao / entradas : 0
  };
}

function recentes() {
  const log = abaLog();
  const n = log.getLastRow() - 1;
  if (n < 1) return [];
  return log.getRange(2, 1, n, 12).getValues()
    .filter(r => r[11] === 'ok').slice(-8).reverse()
    .map(r => ({ uid: r[0], quando: Utilities.formatDate(new Date(r[1]), FUSO, 'dd/MM HH:mm'), origem: r[2], tipo: r[3], aba: textoAba(r[4]), descricao: r[7], valor: r[8], cartao: r[9] }));
}

function atalhos() {
  const log = abaLog();
  const n = log.getLastRow() - 1;
  if (n < 1) return [];
  const mapa = {};
  log.getRange(2, 1, n, 12).getValues().forEach((r, ordem) => {
    if (r[11] !== 'ok' || (r[3] !== 'gasto' && r[3] !== 'cartao')) return;
    const chave = String(r[7]).trim().toLowerCase();
    const item = mapa[chave] || { contagem: 0 };
    Object.assign(item, { descricao: r[7], tipo: r[3], cartao: r[9], categoria: r[10], valor: r[8], ordem });
    item.contagem++;
    mapa[chave] = item;
  });
  return Object.values(mapa).sort((a, b) => b.contagem - a.contagem || b.ordem - a.ordem).slice(0, 6);
}

function parcelamentosAtivos() {
  const vals = planilha().getSheetByName('Parcelamentos').getRange('A2:G100').getValues();
  const hoje = new Date();
  const out = [];
  vals.forEach(r => {
    const [id, desc, cartao, , valor, totRaw, ini] = r;
    if (!desc || !(ini instanceof Date)) return;
    const fixa = totRaw === '' || Number(totRaw) === 0;
    const tot = fixa ? null : Number(totRaw);
    const n = (hoje.getFullYear() - ini.getFullYear()) * 12 + (hoje.getMonth() - ini.getMonth()) + 1;
    if (!fixa && n > tot) return;
    out.push({
      id, descricao: desc, cartao, valor: Number(valor), fixa, total: tot,
      atual: Math.max(n, 0), restantes: fixa ? null : tot - Math.max(n, 1) + 1,
      futuro: n < 1, inicio: nomeAba(ini.getFullYear(), ini.getMonth() + 1)
    });
  });
  return out.sort((a, b) => (a.fixa === b.fixa ? (a.restantes || 0) - (b.restantes || 0) : a.fixa ? -1 : 1));
}

/* Tela Resumo: panorama do ano + detalhes de um mês (lidos de uma vez só) */
function painel(aba) {
  const hoje = new Date();
  aba = aba || nomeAba(hoje.getFullYear(), hoje.getMonth() + 1);
  const num = v => Number(v) || 0;

  const pan = planilha().getSheetByName('Panorama anual');
  let panorama = [];
  if (pan) {
    const faixa = pan.getRange('B6:E17');
    const v = faixa.getValues(), t = faixa.getDisplayValues();
    panorama = v.map((r, i) => ({ aba: t[i][0], gastos: num(r[1]), entradas: num(r[2]), sobra: num(r[3]) }))
      .filter(m => m.aba);
  }

  const sh = planilha().getSheetByName(aba);
  if (!sh) return { aba, panorama, mes: null };
  const faixa = sh.getRange(1, 1, Math.max(sh.getLastRow(), 30), 23);
  const v = faixa.getValues(), t = faixa.getDisplayValues();
  const linhas = (de, ate) => v.slice(de - 1, ate).map((r, i) => ({ r, t: t[de - 1 + i] }));

  return {
    aba, panorama,
    mes: {
      saldo: num(v[1][17]), totalGastos: num(v[1][3]), entradas: num(v[14][17]),
      saldoAnterior: num(v[15][17]), previstos: num(v[25][17]),
      fixos: num(v[5][6]), cartao: num(v[22][6]), gastosMes: num(v[5][13]),
      categorias: linhas(4, 22).filter(x => String(x.r[19]).trim())
        .map(x => ({ nome: x.r[19], esperado: num(x.r[20]), gasto: num(x.r[21]) })),
      pagamentos: linhas(25, 30).filter(x => String(x.r[19]).trim())
        .map(x => ({ nome: x.r[19], valor: num(x.r[20]), pago: x.r[22] === true })),
      listaEntradas: linhas(9, 14).filter(x => String(x.r[16]).trim() && num(x.r[17]))
        .map(x => ({ nome: x.r[16], valor: num(x.r[17]) })),
      itens: []
        .concat(linhas(10, 22).filter(x => String(x.r[2]).trim() && num(x.r[8])).map(x => (
          { grupo: 'Fixo', nome: x.r[2], info: x.t[5], cartao: x.r[6], categoria: x.r[7], valor: num(x.r[8]), pago: x.r[4] === true })))
        .concat(linhas(10, 54).filter(x => String(x.r[10]).trim() && num(x.r[14])).map(x => (
          { grupo: 'Gasto do mês', nome: x.r[10], info: x.t[11], cartao: x.r[12], categoria: x.r[13], valor: num(x.r[14]) })))
        .concat(linhas(27, v.length).filter(x => String(x.r[2]).trim() && num(x.r[8])).map(x => (
          { grupo: 'Cartão', nome: x.r[2], info: x.t[3], cartao: x.r[6], categoria: x.r[7], valor: num(x.r[8]) })))
    }
  };
}

/* =========================================================
 * IA (Gemini): frase -> lançamento
 * ========================================================= */
function interpretar(texto) {
  const key = prop('GEMINI_KEY');
  if (!key) throw new Error('A IA está desligada: coloque a GEMINI_KEY em configurar().');
  if (!texto || !String(texto).trim()) throw new Error('Escreva o gasto primeiro.');

  const cartoes = lista('Configurações', 'D4:D20').filter(c => c !== 'Conta');
  const categorias = lista('Configurações', 'A4:A30');
  const hoje = Utilities.formatDate(new Date(), FUSO, 'yyyy-MM-dd');
  const prox = new Date(); prox.setDate(1); prox.setMonth(prox.getMonth() + 1);
  const mesPadrao = Utilities.formatDate(prox, FUSO, 'yyyy-MM');

  const prompt = `Você converte uma frase curta, em português do Brasil, em um lançamento financeiro.
Hoje é ${hoje}. Responda APENAS com um objeto JSON, sem explicações, neste formato:
{"tipo":"cartao" | "gasto" | "entrada",
 "descricao": texto curto com inicial maiúscula,
 "valor": número (para parcelado, o valor de CADA parcela),
 "cartao": um destes exatamente ${JSON.stringify(cartoes)} ou null,
 "categoria": uma destas exatamente ${JSON.stringify(categorias)} ou null,
 "parcelas": número inteiro ou "fixa",
 "mes": "AAAA-MM" da primeira fatura (só para cartao),
 "data": "AAAA-MM-DD" (para gasto e entrada),
 "duvida": null ou uma pergunta curta se faltar o valor ou algo essencial}
Regras:
- Compra no cartão de crédito (cita ${cartoes.filter(c => c !== 'Débito').join(', ')}, "cartão", "crédito", "em 3x", "parcelado" ou "assinatura") => tipo "cartao". Sem parcelas ditas => 1. "assinatura", "todo mês", "mensal", "fixo" => "fixa". "mes" padrão: ${mesPadrao}.
- "300 em 3x" => valor 100 e parcelas 3. "3x de 50" => valor 50 e parcelas 3.
- Débito, pix, dinheiro ou sem forma de pagamento => tipo "gasto", cartao "Débito", data de hoje (entenda "ontem", "sexta" etc.).
- "recebi", "ganhei", "entrou", salário, FGTS, 13º, bolsa => tipo "entrada" (cartao e categoria null).
- Valores em reais: "23,50" = 23.5, "1.200" = 1200, "1,2k" = 1200.
- Escolha a categoria mais provável (Uber => Uber/transporte, lanche/ifood => IFood/restaurante, mercado => Mercado).
Frase: """${String(texto).slice(0, 300)}"""`;

  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 }
  });

  const modelos = [prop('GEMINI_MODEL')].concat(MODELOS_GEMINI).filter(Boolean);
  let ultimoErro = '';
  for (const modelo of modelos) {
    const r = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
      method: 'post', contentType: 'application/json', payload,
      headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
    });
    const code = r.getResponseCode();
    if (code === 404 || code === 403 || code === 429) {   // modelo inexistente, sem acesso ou sem cota: tenta o próximo
      ultimoErro = `${modelo} respondeu ${code}`;
      continue;
    }
    if (code !== 200) {
      let msg = r.getContentText();
      try { msg = JSON.parse(msg).error.message; } catch (e) {}
      throw new Error('Gemini respondeu erro ' + code + ': ' + msg);
    }
    const corpo = JSON.parse(r.getContentText());
    const txt = ((corpo.candidates || [])[0] || {}).content?.parts?.map(p => p.text || '').join('') || '';
    const l = JSON.parse(txt.replace(/```json|```/g, '').trim());
    if (!cartoes.includes(l.cartao)) l.cartao = l.tipo === 'gasto' ? 'Débito' : null;
    if (!categorias.includes(l.categoria)) l.categoria = null;
    if (l.tipo === 'cartao' && !/^\d{4}-\d{2}$/.test(l.mes || '')) l.mes = mesPadrao;
    if (l.tipo !== 'cartao' && !/^\d{4}-\d{2}-\d{2}$/.test(l.data || '')) l.data = hoje;
    return l;
  }
  throw new Error('Nenhum modelo do Gemini respondeu (' + ultimoErro + '). Defina GEMINI_MODEL nas propriedades do script.');
}

/* =========================================================
 * Utilidades
 * ========================================================= */
function planilha() { return SpreadsheetApp.getActive(); }
function prop(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function nomeAba(ano, mes) { return MESES[mes - 1] + '/' + String(ano).slice(2); }

// Registros antigos do App_Log viraram data ("out./26"); volta para o nome da aba
function textoAba(v) {
  if (!(v instanceof Date)) return String(v);
  const [m, a] = Utilities.formatDate(v, planilha().getSpreadsheetTimeZone(), 'M-yyyy').split('-').map(Number);
  return nomeAba(a, m);
}

function abaMes(aba) {
  const sh = planilha().getSheetByName(aba);
  if (!sh) throw new Error(`Não existe a aba ${aba} na planilha.`);
  return sh;
}

function abaLog() {
  let sh = planilha().getSheetByName('App_Log');
  if (!sh) {
    sh = planilha().insertSheet('App_Log');
    sh.appendRow(['uid', 'quando', 'origem', 'tipo', 'aba', 'linha', 'ref', 'descricao', 'valor', 'cartao', 'categoria', 'status']);
    sh.setFrozenRows(1);
    sh.hideSheet();
  }
  return sh;
}

function pinOk(pin) {
  const certo = prop('PIN');
  if (!certo) throw new Error('PIN não configurado. Rode configurar() no Apps Script.');
  return String(pin || '') === certo;
}

function validar(d, campos) {
  campos.forEach(c => {
    if (d[c] === undefined || d[c] === null || String(d[c]).trim() === '') throw new Error('Campo obrigatório vazio: ' + c);
  });
  if (!(Number(d.valor) > 0)) throw new Error('O valor precisa ser maior que zero.');
}

function lista(aba, intervalo) {
  return planilha().getSheetByName(aba).getRange(intervalo).getValues().flat().map(String).filter(v => v.trim() !== '');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
