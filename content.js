function extrairCarteira() {
  const linhas = document.querySelectorAll('tr[data-pc-section="bodyrow"]');

  if (!linhas || linhas.length === 0) {
    return { erro: 'Nenhuma linha encontrada. Verifique se está na página de carteira do Investidor10.' };
  }

  const ativos = [];

  linhas.forEach((tr) => {
    try {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 16) return;

      // td[0] = Ticker
      const ticker = tds[0].querySelector('.name')?.innerText?.trim() ?? '';
      if (!ticker) return;

      // td[1] = Quantidade
      const qtdTexto = tds[1].innerText?.trim() ?? '0';
      const quantidade = parseInt(qtdTexto.replace(/\./g, '').replace(',', '.')) || 0;

      // td[3] = Preço Atual  (ex: "R$ 46,62")
      const precoTexto = tds[3].innerText?.trim() ?? '';
      const preco = parseFloat(
        precoTexto
          .replace('R$', '')
          .replace(/\u00a0/g, '')
          .replace(/\s/g, '')
          .replace(/\./g, '')
          .replace(',', '.')
          .trim()
      );

      // td[14] = % Carteira atual  (ex: "10,24%")
      const pctCarteiraTexto = tds[14].innerText?.trim() ?? '';
      const pctCarteira = parseFloat(
        pctCarteiraTexto.replace('%', '').replace(',', '.').trim()
      );

      // td[15] = % Ideal  (ex: "11,00%")
      const pctIdealTexto = tds[15].innerText?.trim() ?? '';
      const pctIdeal = parseFloat(
        pctIdealTexto.replace('%', '').replace(',', '.').trim()
      );

      if (!ticker || isNaN(preco) || isNaN(pctCarteira) || isNaN(pctIdeal)) {
        console.warn(`[I10-Ext] ${ticker} ignorado:`, { precoTexto, pctCarteiraTexto, pctIdealTexto });
        return;
      }

      ativos.push({ ticker, quantidade, preco, pctCarteira, pctIdeal });

    } catch (e) {
      console.warn('[I10-Ext] Erro ao processar linha:', e);
    }
  });

  if (ativos.length === 0) {
    return { erro: 'Nenhum ativo válido. Verifique se as colunas "% Carteira" e "% Ideal" estão visíveis na tabela.' };
  }

  console.log(`[I10-Ext] ${ativos.length} ativos extraídos:`, ativos);
  return { ativos };
}

if (!window.__i10ExtRegistered) {
  window.__i10ExtRegistered = true;
  chrome.runtime.onMessage.addListener((msg, sender, responder) => {
    if (msg.tipo === 'extrairCarteira') {
      responder(extrairCarteira());
    }
    return true;
  });
}