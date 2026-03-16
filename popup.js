let carteira = [];

// ── Helpers de formatação ──────────────────────────────
const fmtBRL = (v) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtPct = (v) => v.toFixed(2).replace('.', ',') + '%';

// ── Função que roda DENTRO da página ──────────────────
function extrairCarteiraInPage() {
  const linhas = document.querySelectorAll('tr[data-pc-section="bodyrow"]');
  if (!linhas || linhas.length === 0) return { erro: 'Nenhuma linha encontrada.' };

  // Converte texto BR para float: "R$ 1.234,56" → 1234.56
  function parseBRL(texto) {
    return parseFloat(
      (texto || '')
        .replace('R$', '')
        .replace(/\u00a0/g, '')
        .replace(/\s/g, '')
        .replace(/\./g, '')
        .replace(',', '.')
        .trim()
    );
  }

  function parsePct(texto) {
    return parseFloat(
      (texto || '').replace('%', '').replace(',', '.').trim()
    );
  }

  const ativos = [];

  linhas.forEach((tr) => {
    try {
      const tds = tr.querySelectorAll('td');

      // ── Ticker ──
      // Ações/FIIs/BDRs têm .name, Tesouro não tem imagem mas tem .name também
      const ticker = tds[0].querySelector('.name')?.innerText?.trim() ?? '';
      if (!ticker) return;

      // ── Quantidade ── sempre td[1]
      const qtdTexto = tds[1].innerText?.trim() ?? '0';
      const quantidade = parseFloat(qtdTexto.replace(/\./g, '').replace(',', '.')) || 0;

      // ── Preço Atual ──
      // Busca o primeiro td que contenha "R$" com .show-sensitive-content (preço atual)
      // Ações: td[3], FIIs: td[3], BDR: td[3], ETF: td[3]
      // Tesouro não tem preço atual unitário — usamos o Saldo dividido pela qtd
      let preco = NaN;
      for (let i = 2; i < tds.length; i++) {
        const txt = tds[i].innerText?.trim() ?? '';
        // Preço atual: célula com "R$" e valor numérico simples (não é saldo grande)
        // Evita pegar a coluna de saldo (valor muito alto)
        if (txt.startsWith('R$') || txt.includes('R$\u00a0')) {
          const val = parseBRL(txt);
          if (!isNaN(val) && val > 0 && val < 100000) {
            preco = val;
            break;
          }
        }
      }

      // Tesouro: não tem coluna de preço unitário — calcula pelo saldo
      if (isNaN(preco) && quantidade > 0) {
        for (let i = 2; i < tds.length; i++) {
          const txt = tds[i].innerText?.trim() ?? '';
          if (txt.startsWith('R$') || txt.includes('R$\u00a0')) {
            const val = parseBRL(txt);
            if (!isNaN(val) && val > 0) {
              preco = val / quantidade;
              break;
            }
          }
        }
      }

      // ── % Carteira e % Ideal ──
      // Estratégia: percorre os TDs de trás para frente buscando os dois últimos
      // que contenham "%" e sejam valores numéricos válidos.
      // Isso funciona para qualquer tipo (Ações=td[15]/td[14], FIIs=td[14]/td[13], etc.)
      // A ordem é: ...| % Carteira | % Ideal | Sim/Não | ⋮ |
      const pctCols = [];
      for (let i = tds.length - 1; i >= 0 && pctCols.length < 2; i--) {
        const txt = tds[i].innerText?.trim() ?? '';
        if (txt.includes('%')) {
          const val = parsePct(txt);
          if (!isNaN(val)) pctCols.unshift(txt); // insere no início para manter ordem
        }
      }

      if (pctCols.length < 2) {
        console.warn(`[I10-Ext] ${ticker}: não encontrou % Carteira e % Ideal`, pctCols);
        return;
      }

      const pctCarteira = parsePct(pctCols[0]);
      const pctIdeal    = parsePct(pctCols[1]);

      if (!ticker || isNaN(preco) || isNaN(pctCarteira) || isNaN(pctIdeal)) {
        console.warn(`[I10-Ext] ${ticker} ignorado:`, { preco, pctCarteira, pctIdeal });
        return;
      }

      ativos.push({ ticker, quantidade, preco, pctCarteira, pctIdeal });

    } catch (e) {
      console.warn('[I10-Ext] Erro ao processar linha:', e);
    }
  });

  if (ativos.length === 0) return { erro: 'Nenhum ativo válido. Verifique se as colunas "% Carteira" e "% Ideal" estão visíveis.' };

  console.log(`[I10-Ext] ${ativos.length} ativos extraídos:`, ativos);
  return { ativos };
}

// ── Calcula o aporte necessário para equilibrar (diff absoluta < 1%) ──
function calcularParaEquilibrio(ativos) {
  const elegíveisBase = ativos.filter((a) => a.pctIdeal > 0);
  if (elegíveisBase.length === 0) return null;

  const valorTotalAtual = ativos.reduce((acc, a) => acc + a.quantidade * a.preco, 0);
  const precoMin = Math.min(...elegíveisBase.map((a) => a.preco));

  // Verifica equilíbrio dado um conjunto de estado simulado
  function estaEquilibrado(estadoSim, totalSim) {
    return estadoSim
      .filter((a) => a.pctIdeal > 0)
      .every((a) => {
        const fatorCrescimento = (a.quantidade + a.cotasComprar) / a.quantidade;
        const fatorDiluicao = valorTotalAtual / totalSim;
        const pctAtual = a.pctCarteira * fatorCrescimento * fatorDiluicao;
        return Math.abs(pctAtual - a.pctIdeal) < 2;
      });
  }

  // Usa blocos crescentes para encontrar o valor — começa verificando se já está ok
  let aporte = 0;
  const MAX = 10_000_000;
  const PASSO = precoMin; // incrementa de cota em cota (mínimo possível)

  // Verifica se já está equilibrada com aporte 0
  const estadoZero = ativos.map((a) => ({ ...a, cotasComprar: 0, valorAlocado: 0 }));
  if (estaEquilibrado(estadoZero, valorTotalAtual)) return 0;

  // Simula usando o mesmo calcularAporte incrementalmente
  for (let iter = 0; iter < 100000 && aporte < MAX; iter++) {
    aporte += PASSO;
    const { estado } = calcularAporte(ativos, aporte);
    const totalSim = valorTotalAtual + (aporte - estado.reduce((acc, a) =>
      acc + (aporte - (aporte - a.valorAlocado)), 0));

    // Calcula total real investido
    const totalInvestido = estado.reduce((acc, a) => acc + a.valorAlocado, 0);
    const totalFinal = valorTotalAtual + totalInvestido;

    if (estaEquilibrado(estado, totalFinal)) return aporte;
  }

  return aporte;
}

// ── Algoritmo de rebalanceamento ──────────────────────────
function calcularAporte(ativos, valorAporte) {
  const valorTotalAtual = ativos.reduce((acc, a) => acc + a.quantidade * a.preco, 0);
  const estado = ativos.map((a) => ({ ...a, cotasComprar: 0, valorAlocado: 0 }));
  const elegíveis = estado.filter((a) => a.pctIdeal > 0);

  let saldoRestante = valorAporte;
  const precoMin = () => Math.min(...elegíveis.map((a) => a.preco));

  for (let iter = 0; iter < 100000 && saldoRestante >= precoMin(); iter++) {
    const valorTotalSimulado = valorTotalAtual + (valorAporte - saldoRestante);

    // pctAtual = pctCarteira da página escalado pelas cotas compradas na simulação
    const comDeficit = elegíveis.map((a) => {
      const fatorCrescimento = (a.quantidade + a.cotasComprar) / a.quantidade;
      const fatorDiluicao = valorTotalAtual / valorTotalSimulado;
      const pctAtual = a.pctCarteira * fatorCrescimento * fatorDiluicao;
      const deficit = (a.pctIdeal - pctAtual) / a.pctIdeal;
      return { ativo: a, deficit, pctAtual };
    }).sort((a, b) => b.deficit - a.deficit);

    const maiorDeficit = comDeficit[0].deficit;
    if (maiorDeficit <= 0) break;

    const grupo = comDeficit.filter((d) => d.deficit >= maiorDeficit - 0.01);
    const candidato = grupo
      .sort((a, b) => a.ativo.preco - b.ativo.preco)
      .find((d) => d.ativo.preco <= saldoRestante);

    if (!candidato) {
      const qualquer = comDeficit
        .filter((d) => d.deficit > 0 && d.ativo.preco <= saldoRestante)[0];
      if (!qualquer) break;
      qualquer.ativo.cotasComprar += 1;
      qualquer.ativo.valorAlocado += qualquer.ativo.preco;
      saldoRestante -= qualquer.ativo.preco;
    } else {
      candidato.ativo.cotasComprar += 1;
      candidato.ativo.valorAlocado += candidato.ativo.preco;
      saldoRestante -= candidato.ativo.preco;
    }
  }

  const sobra = saldoRestante;
  const totalInvestido = valorAporte - sobra;
  const ativosComCompra = estado.filter((a) => a.cotasComprar > 0).length;
  return { estado, sobra, totalInvestido, ativosComCompra };
}

// ── Renderização da tabela ────────────────────────────────
function renderTabela(estado, valorAporte) {
  const corpo = document.getElementById('tabela-body');
  corpo.innerHTML = '';

  const sorted = [...estado].sort((a, b) => b.valorAlocado - a.valorAlocado);
  const maxCotas = Math.max(...sorted.map((a) => a.cotasComprar), 1);

  sorted.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'ativo-row';
    row.style.animationDelay = `${i * 30}ms`;

    const barWidth = (a.cotasComprar / maxCotas) * 100;

    row.innerHTML = `
      <div class="cell ticker">
        ${a.ticker}
        ${a.cotasComprar > 0 && i === 0 ? '<div><span class="badge top">top</span></div>' : ''}
      </div>
      <div class="cell comprar">
        <div class="cotas-valor ${a.cotasComprar === 0 ? 'zero' : ''}">
          ${a.cotasComprar > 0 ? `+${a.cotasComprar} cota${a.cotasComprar > 1 ? 's' : ''}` : '—'}
        </div>
        ${a.cotasComprar > 0 ? `<div class="deficit-bar"><div class="deficit-fill" style="width:${barWidth}%"></div></div>` : ''}
      </div>
      <div class="cell">${fmtBRL(a.preco)}</div>
      <div class="cell" style="color:var(--muted)">${fmtPct(a.pctCarteira)}</div>
      <div class="cell" style="color:${a.pctIdeal > 0 ? 'var(--accent2)' : 'var(--muted2)'}">${fmtPct(a.pctIdeal)}</div>
      <div class="cell">${a.cotasComprar > 0 ? fmtBRL(a.valorAlocado) : '—'}</div>
    `;

    corpo.appendChild(row);
  });
}

// ── Calcular ──────────────────────────────────────────────
function calcular() {
  const input = document.getElementById('aporte');
  const valor = parseFloat(input.value);

  if (isNaN(valor) || valor <= 0) {
    input.style.borderColor = 'var(--danger)';
    setTimeout(() => (input.style.borderColor = ''), 1000);
    return;
  }

  const { estado, sobra, totalInvestido, ativosComCompra } = calcularAporte(carteira, valor);

  document.getElementById('res-aporte').textContent = fmtBRL(valor);
  document.getElementById('res-investido').textContent = fmtBRL(totalInvestido);
  document.getElementById('res-sobra').textContent = fmtBRL(sobra);
  document.getElementById('res-ativos').textContent = `${ativosComCompra} ativo${ativosComCompra !== 1 ? 's' : ''}`;

  document.getElementById('resumo').classList.add('visible');
  document.getElementById('tabela-section').classList.add('visible');

  renderTabela(estado, valor);
}

// ── Listeners ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-calcular')?.addEventListener('click', calcular);
  document.getElementById('aporte')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') calcular();
  });

  document.getElementById('btn-plus')?.addEventListener('click', () => {
    const input = document.getElementById('aporte');
    const atual = parseFloat(input.value) || 0;
    input.value = (atual + 500).toFixed(2);
    calcular();
  });

  document.getElementById('btn-minus')?.addEventListener('click', () => {
    const input = document.getElementById('aporte');
    const atual = parseFloat(input.value) || 0;
    const novo = Math.max(0, atual - 500);
    input.value = novo > 0 ? novo.toFixed(2) : '';
    if (novo > 0) calcular();
  });
});

// ── Init ──────────────────────────────────────────────────
async function init() {
  const statusArea   = document.getElementById('status-area');
  const inputSection = document.getElementById('input-section');
  const emptyArea    = document.getElementById('empty-area');
  const qtdAtivos    = document.getElementById('qtd-ativos');

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    statusArea.className = 'status erro';
    statusArea.innerHTML = '✗ Erro ao acessar a aba ativa.';
    return;
  }

  if (!tab.url?.includes('investidor10.com.br')) {
    statusArea.className = 'status erro';
    statusArea.innerHTML = '✗ Abra a carteira no Investidor10 primeiro.';
    qtdAtivos.textContent = 'fora do investidor10';
    return;
  }

  try {
    const resultados = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extrairCarteiraInPage,
    });

    const resp = resultados?.[0]?.result;

    if (!resp) {
      statusArea.className = 'status erro';
      statusArea.innerHTML = '✗ Sem resposta. Recarregue a página e tente novamente.';
      return;
    }

    if (resp.erro) {
      statusArea.className = 'status erro';
      statusArea.innerHTML = `✗ ${resp.erro}`;
      emptyArea.style.display = 'block';
      return;
    }

    carteira = resp.ativos;
    statusArea.style.display = 'none';
    inputSection.style.display = 'block';
    qtdAtivos.textContent = `${carteira.length} ativos carregados`;

    // Calcula e exibe o valor para equilibrar
    const valorEquilibrio = calcularParaEquilibrio(carteira);
    const cardEquilibrio = document.getElementById('equilibrio-card');
    const valorEl = document.getElementById('equilibrio-valor');
    if (valorEquilibrio !== null) {
      valorEl.textContent = valorEquilibrio === 0
        ? '✓ Carteira equilibrada!'
        : fmtBRL(valorEquilibrio);
      cardEquilibrio.style.display = 'flex';
    }

  } catch (e) {
    statusArea.className = 'status erro';
    statusArea.innerHTML = `✗ Erro: ${e.message}`;
  }
}

init();