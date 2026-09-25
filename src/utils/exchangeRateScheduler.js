const supabase = require('../config/supabase');

// Actualiza exchange_rates una vez al día desde open.er-api.com (gratis, sin clave,
// actualiza diario, cubre 160+ monedas — incluye las raras que maneja Bit como PYG y DOP).
// La tabla guarda "cuántos USD vale 1 unidad de la moneda" (rate_to_usd), y la API da la
// relación al revés (cuántas unidades de la moneda vale 1 USD) — por eso se invierte (1/x).
const CURRENCIES = ['COP', 'MXN', 'PYG', 'DOP', 'EUR'];
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 día

async function syncExchangeRates() {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await r.json();
    if (data.result !== 'success') {
      console.warn('[exchange-rate-scheduler] la API no devolvió éxito:', data.result);
      return;
    }

    let updated = 0;
    for (const currency of CURRENCIES) {
      const usdToCurrency = data.rates?.[currency];
      if (!usdToCurrency) continue;
      const rateToUsd = 1 / usdToCurrency;
      const { error } = await supabase
        .from('exchange_rates')
        .upsert({ currency, rate_to_usd: rateToUsd, updated_at: new Date().toISOString() }, { onConflict: 'currency' });
      if (!error) updated++;
    }
    console.log(`[exchange-rate-scheduler] ${updated}/${CURRENCIES.length} monedas actualizadas`);
  } catch (err) {
    console.error('[exchange-rate-scheduler] falló:', err.message);
  }
}

function startExchangeRateScheduler() {
  setTimeout(syncExchangeRates, 15_000);
  setInterval(syncExchangeRates, INTERVAL_MS);
  console.log('[exchange-rate-scheduler] activo — actualiza los tipos de cambio cada 24 horas');
}

module.exports = { startExchangeRateScheduler };
